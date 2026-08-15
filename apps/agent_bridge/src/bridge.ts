import { randomUUID } from "node:crypto";
import {
  DeviceActionVerifier,
  EventDeduper,
  EventReplayBuffer,
  PairingManager,
  RequestLedger,
  isSessionState,
  makeGlobalSessionId,
  parseGlobalSessionId,
  type AgentEvent,
  type EventReplaySlice,
  type ApprovalResponse,
  type ConfigureWalletRequest,
  type BranchSessionResult,
  type ContextHandoffResult,
  type DelegationChild,
  type DelegationTarget,
  type DelegationTask,
  type Host,
  type JsonObject,
  type ProviderConnection,
  type ProviderWalletStatus,
  type QueuedMessage,
  type RefreshResult,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionContextState,
  type SessionRelationship,
  type SignedDeviceAction,
  type UserInputResponse,
    type PairingState,
  type VisionProxySelection,
  type VisionProxyStatus,
  type VisionProxyTarget,
} from "../../../packages/protocol/src/index.js";
import {
  ProviderAdapterError,
  providerErrorFromUnknown,
  collectAllSessionPages,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type CreateSessionOptions,
  type EditMessageRequest,
  type ProviderEvent,
  type ProviderDetection,
  type ProviderQueuedMessage,
  type ProviderClientTooling,
  type MessageAttachment,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../../packages/provider_contract/src/index.js";
import { ApprovalRegistry } from "./approvals.js";
import { AttachmentUploadManager, type BeginAttachmentUpload } from "./attachment_uploads.js";
import type { BridgeConfig } from "./config.js";
import {
  defaultTranscriptionSourceRegistry,
  openAiTranscriptionSourceId,
  singleTranscriptionSourceRegistry,
  type DictationTranscriber,
  type TranscriptionSourceRegistry,
} from "./dictation.js";
import { RefreshCoordinator } from "./refresh.js";
import { SessionCache } from "./session_cache.js";
import { UserInputRegistry } from "./user_inputs.js";
import {
  branchBootstrap,
  branchBootstrapWithUserRequest,
  clientVisibleBranchMessages,
  clientVisibleHandoffMessages,
  handoffBootstrap,
  handoffSummary,
  persistableBranchMessages,
} from "./context_transfer.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";

export interface OpenSessionResult {
  readonly session: RemoteSession;
  readonly messages: readonly RemoteMessage[];
  readonly nextCursor: string | null;
}

interface QueuedMessageRecord {
  view: QueuedMessage;
  readonly request?: SendMessageRequest;
  readonly providerOwned: boolean;
  readonly providerMessageId?: string;
}

interface DelegationRuntime {
  task: DelegationTask;
  readonly sawWorking: Set<string>;
  resultsReady: boolean;
  synthesisDispatched: boolean;
}

interface MessageSnapshotRecord {
  readonly messages: readonly RemoteMessage[];
  readonly generation: number;
  readonly freshUntil: number;
}

interface OpenSessionLoad {
  readonly generation: number;
  readonly promise: Promise<{ readonly session: RemoteSession; readonly messages: readonly RemoteMessage[] }>;
}

interface VisionProxyRuntime {
  selection: VisionProxySelection;
  helperSessionId?: string;
  readonly attachments: Map<string, MessageAttachment>;
}

interface PendingContextHandoff {
  readonly summary: string;
  readonly relationship: SessionRelationship;
  readonly prompt?: string;
}

interface PendingBranchBootstrap {
  readonly bootstrap: string;
  readonly relationship: SessionRelationship;
}

const messageSnapshotTtlMs = 2_000;
const maxMessageSnapshots = 32;
const maxPersistedSessionTransfers = 1_000;
export const visionProxyDeveloperInstructions = "You are acting as visual support for another model. Answer only the visual question you receive using the attached image or images. Report what is visible accurately and concisely, including relevant text, layout, states, positions, and uncertainty. Do not take actions, make unrelated plans, or continue the parent task. Do not claim details you cannot see. Return a self-contained observation that the requesting model can use directly.";

export function messagePage(
  messages: readonly RemoteMessage[],
  cursor: string | undefined,
  limit: number,
): { readonly messages: readonly RemoteMessage[]; readonly nextCursor: string | null } {
  const end = cursor === undefined ? messages.length : Number.parseInt(cursor, 10);
  if (!Number.isInteger(end) || end < 0 || end > messages.length) throw new Error("Message history cursor is invalid");
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function finitePositiveSafeInteger(value: unknown): number | null {
  const normalized = finiteNonNegativeInteger(value);
  return normalized !== null && normalized > 0 && Number.isSafeInteger(normalized)
    ? normalized
    : null;
}

function contextPercent(used: number | null, window: number | null, reported: unknown): number | null {
  if (used !== null && window !== null && window > 0) return Math.max(0, Math.min(100, used / window * 100));
  return typeof reported === "number" && Number.isFinite(reported)
    ? Math.max(0, Math.min(100, reported))
    : null;
}

function minimumCompactionThreshold(contextWindowTokens: number): number {
  if (contextWindowTokens <= 0) return 0;
  const fivePercentRoundedUp = Math.ceil((contextWindowTokens * 0.05) / 1_000) * 1_000;
  return Math.min(contextWindowTokens, Math.max(1_000, fivePercentRoundedUp));
}

export class AgentBridge {
  readonly #adapters = new Map<string, AgentProviderAdapter>();
  readonly #messageSnapshots = new Map<string, MessageSnapshotRecord>();
  readonly #messageSnapshotGenerations = new Map<string, number>();
  readonly #openSessionLoads = new Map<string, OpenSessionLoad>();
  readonly #cache = new SessionCache();
  readonly #events: EventReplayBuffer;
  readonly #deduper = new EventDeduper();
  readonly #subscriptions: Subscription[] = [];
  readonly #subscribedProviders = new Set<string>();
  readonly #providerConnectionErrors = new Map<string, ReturnType<typeof providerErrorFromUnknown>>();
  readonly #approvals = new ApprovalRegistry();
  readonly #userInputs = new UserInputRegistry();
  readonly #pairing: PairingManager;
  readonly #deviceVerifier: DeviceActionVerifier;
  readonly #sendLedger = new RequestLedger<SendMessageResult>();
  readonly #pendingContextHandoffs = new Map<string, PendingContextHandoff>();
  readonly #pendingBranchBootstraps = new Map<string, PendingBranchBootstrap>();
  readonly #branchCopies = new Map<string, readonly RemoteMessage[]>();
  readonly #sessionTransfers = new Map<string, SessionTransferRecord>();
  readonly #pendingHandoffSends = new Map<string, Promise<void>>();
  readonly #attachmentUploads: AttachmentUploadManager;
  readonly #transcriptionSources: TranscriptionSourceRegistry;
  readonly #queuedMessages = new Map<string, QueuedMessageRecord>();
  readonly #queuePumps = new Set<string>();
  readonly #delegations = new Map<string, DelegationRuntime>();
  readonly #visionProxies = new Map<string, VisionProxyRuntime>();
  readonly #compactionThresholds = new Map<string, number>();
  readonly #compactingSessions = new Set<string>();
  readonly #lastCompactionUsage = new Map<string, number>();
  readonly #internalSessionIds = new Set<string>();
  readonly #internalSessionCreations = new Map<string, { depth: number; readonly events: ProviderEvent[] }>();
  readonly #delegationPumps = new Set<string>();
  readonly #onDelegationsChange: ((tasks: readonly DelegationTask[]) => void) | undefined;
  readonly #onSessionTransfersChange: ((transfers: readonly SessionTransferRecord[]) => void) | undefined;
  readonly #onPairingConfirmed: (() => void) | undefined;
  #delegationTimer: NodeJS.Timeout | undefined;
  #refresh: RefreshCoordinator;
  #disposed = false;
  #relayConnected = false;
  #started = false;
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(
    public readonly config: BridgeConfig,
    adapters: readonly AgentProviderAdapter[] = [],
    pairingOptions: {
      readonly state?: PairingState;
      readonly onStateChange?: (state: PairingState) => void;
      readonly onPairingConfirmed?: () => void;
      readonly attachmentUploads?: AttachmentUploadManager;
      readonly dictationTranscriber?: DictationTranscriber;
      readonly transcriptionSources?: TranscriptionSourceRegistry;
      readonly delegations?: readonly DelegationTask[];
      readonly onDelegationsChange?: (tasks: readonly DelegationTask[]) => void;
      readonly sessionTransfers?: readonly SessionTransferRecord[];
      readonly onSessionTransfersChange?: (transfers: readonly SessionTransferRecord[]) => void;
    } = {},
  ) {
    this.#events = new EventReplayBuffer(config.hostId);
    this.#pairing = new PairingManager(config.hostId, config.identity, 5 * 60 * 1_000, pairingOptions.state, pairingOptions.onStateChange);
    this.#onPairingConfirmed = pairingOptions.onPairingConfirmed;
    this.#deviceVerifier = new DeviceActionVerifier(this.#pairing);
    this.#attachmentUploads = pairingOptions.attachmentUploads ?? new AttachmentUploadManager();
    this.#transcriptionSources = pairingOptions.transcriptionSources
      ?? (pairingOptions.dictationTranscriber === undefined
        ? defaultTranscriptionSourceRegistry()
        : singleTranscriptionSourceRegistry(pairingOptions.dictationTranscriber));
    this.#onDelegationsChange = pairingOptions.onDelegationsChange;
    this.#onSessionTransfersChange = pairingOptions.onSessionTransfersChange;
    for (const task of pairingOptions.delegations ?? []) {
      this.#delegations.set(task.id, {
        task,
        sawWorking: new Set(task.children
          .filter((child) => child.sessionId !== undefined && child.state !== "unknown" && child.state !== "disconnected")
          .map((child) => child.sessionId!)),
        resultsReady: task.state === "synthesizing",
        synthesisDispatched: task.state === "synthesizing",
      });
    }
    for (const transfer of pairingOptions.sessionTransfers ?? []) this.restoreSessionTransferRuntime(transfer);
    for (const adapter of adapters) this.registerAdapter(adapter);
    this.#refresh = new RefreshCoordinator(this.#adapters, this.#cache);
  }

  public registerAdapter(adapter: AgentProviderAdapter): void {
    if (this.#started) throw new Error("Register providers before starting the bridge");
    if (this.#adapters.has(adapter.providerId)) throw new Error(`Provider ${adapter.providerId} is already registered`);
    this.#adapters.set(adapter.providerId, adapter);
    if (this.#clientTooling !== undefined) adapter.configureClientTooling?.(this.#clientTooling);
    this.#refresh = new RefreshCoordinator(this.#adapters, this.#cache);
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    if (this.#started) throw new Error("Configure provider tools before starting the bridge");
    this.#clientTooling = tooling;
    for (const adapter of this.#adapters.values()) adapter.configureClientTooling?.(tooling);
  }

  public async start(): Promise<void> {
    this.assertActive();
    if (this.#started) return;
    this.#started = true;
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => this.connectProvider(adapter)));
    this.#events.append({ type: "host.connected", payload: { displayName: this.config.displayName } });
    this.reconcileDelegationTimer();
  }

  public async reconnectProvider(providerId: string): Promise<void> {
    const adapter = this.requireAdapter(providerId);
    await this.connectProvider(adapter);
  }

  public host(): Host {
    const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unknown";
    return {
      id: this.config.hostId,
      displayName: this.config.displayName,
      platform,
      connectionState: this.#disposed ? "offline" : "online",
      protocolVersion: 1,
      lastSeenAt: new Date().toISOString(),
      relayConnected: this.#relayConnected,
    };
  }

  public async authenticateProvider(providerId: string, request: AuthRequest): Promise<AuthResult> {
    this.assertActive();
    const adapter = this.requireAdapter(providerId);
    if (adapter.authenticate === undefined) throw new Error(`${providerId} does not expose an authentication flow`);
    return await adapter.authenticate(request);
  }

  public async listModels(providerId: string): Promise<readonly RemoteModel[]> {
    this.assertActive();
    const adapter = this.requireAdapter(providerId);
    if (adapter.listModels === undefined) throw new Error(`${providerId} does not expose model enumeration`);
    return await adapter.listModels();
  }

  public async walletStatus(providerId: string, modelId?: string, endpointId?: string): Promise<ProviderWalletStatus> {
    this.assertActive();
    const adapter = this.requireAdapter(providerId);
    if (adapter.getWalletStatus !== undefined) return await adapter.getWalletStatus(modelId, endpointId);
    const subscriptionProviders = new Set(["codex", "grok", "copilot"]);
    const subscription = subscriptionProviders.has(providerId);
    return {
      providerId,
      kind: subscription ? "subscription" : "harness",
      label: subscription ? `${adapter.displayName} subscription` : `${adapter.displayName} account`,
      detail: subscription
        ? "This task uses your existing subscription."
        : "This task uses the account configured in this agent.",
      currency: "USD",
      apiKeyConfigured: false,
    };
  }

  public async configureWallet(providerId: string, request: ConfigureWalletRequest): Promise<ProviderWalletStatus> {
    this.assertActive();
    const adapter = this.requireAdapter(providerId);
    if (adapter.configureWallet === undefined) {
      throw new Error(`${adapter.displayName} manages credentials and billing in its own harness`);
    }
    return await adapter.configureWallet(request);
  }

  public async sessionContext(globalSessionId: string): Promise<SessionContextState> {
    this.assertActive();
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const adapter = this.requireAdapter(providerId);
    const session = this.#cache.get(globalSessionId);
    const reported = adapter.getSessionContext === undefined
      ? undefined
      : await adapter.getSessionContext(providerSessionId);
    const contextWindowTokens = finitePositiveSafeInteger(reported?.contextWindowTokens);
    const usedTokens = finiteNonNegativeInteger(reported?.usedTokens);
    const minimumThresholdTokens = contextWindowTokens === null ? null : minimumCompactionThreshold(contextWindowTokens);
    const storedThreshold = this.#compactionThresholds.get(globalSessionId);
    const threshold = storedThreshold === undefined || contextWindowTokens === null || minimumThresholdTokens === null
      ? null
      : Math.max(minimumThresholdTokens, Math.min(contextWindowTokens, storedThreshold));
    if (threshold !== null && threshold !== storedThreshold) this.#compactionThresholds.set(globalSessionId, threshold);
    const supportsManualCompaction = adapter.compactSession !== undefined && reported?.supportsManualCompaction === true;
    return {
      sessionId: globalSessionId,
      ...(reported?.modelId !== undefined ? { modelId: reported.modelId } : session?.modelId !== undefined ? { modelId: session.modelId } : {}),
      usedTokens,
      contextWindowTokens,
      usedPercent: contextPercent(usedTokens, contextWindowTokens, reported?.usedPercent),
      compactionThresholdTokens: threshold,
      minimumThresholdTokens,
      supportsManualCompaction,
      supportsThreshold: supportsManualCompaction && contextWindowTokens !== null,
      isCompacting: this.#compactingSessions.has(globalSessionId),
      updatedAt: reported?.updatedAt ?? new Date().toISOString(),
      usage: reported?.usage ?? {},
    };
  }

  public async setSessionCompactionThreshold(
    globalSessionId: string,
    thresholdTokens: number,
    compactNow: boolean,
  ): Promise<SessionContextState> {
    if (!Number.isSafeInteger(thresholdTokens)) throw new Error("Compaction threshold must be a whole number of tokens");
    const context = await this.sessionContext(globalSessionId);
    if (!context.supportsThreshold || context.contextWindowTokens === null || context.minimumThresholdTokens === null) {
      throw new Error("This provider does not expose safe context compaction controls");
    }
    if (thresholdTokens < context.minimumThresholdTokens) {
      throw new Error(`Compaction threshold must be at least ${context.minimumThresholdTokens} tokens`);
    }
    if (thresholdTokens > context.contextWindowTokens) {
      throw new Error(`Compaction threshold cannot exceed this model's ${context.contextWindowTokens}-token context window`);
    }
    if (context.usedTokens !== null && thresholdTokens <= context.usedTokens && !compactNow) {
      throw new Error("This conversation is already above that threshold. Confirm immediate compaction or choose a higher value.");
    }
    const previousThreshold = this.#compactionThresholds.get(globalSessionId);
    const previousCompactionUsage = this.#lastCompactionUsage.get(globalSessionId);
    this.#compactionThresholds.set(globalSessionId, thresholdTokens);
    this.#lastCompactionUsage.delete(globalSessionId);
    try {
      if (context.usedTokens !== null && thresholdTokens <= context.usedTokens) await this.compactSession(globalSessionId);
    } catch (error) {
      if (previousThreshold === undefined) this.#compactionThresholds.delete(globalSessionId);
      else this.#compactionThresholds.set(globalSessionId, previousThreshold);
      if (previousCompactionUsage === undefined) this.#lastCompactionUsage.delete(globalSessionId);
      else this.#lastCompactionUsage.set(globalSessionId, previousCompactionUsage);
      throw error;
    }
    return await this.sessionContext(globalSessionId);
  }

  public async compactSession(globalSessionId: string): Promise<void> {
    this.assertActive();
    if (this.#compactingSessions.has(globalSessionId)) return;
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const adapter = this.requireAdapter(providerId);
    if (adapter.compactSession === undefined) throw new Error(`${adapter.displayName} does not expose context compaction`);
    this.#compactingSessions.add(globalSessionId);
    try {
      const before = await this.sessionContext(globalSessionId).catch(() => undefined);
      if (before?.usedTokens !== null && before?.usedTokens !== undefined) this.#lastCompactionUsage.set(globalSessionId, before.usedTokens);
      await adapter.compactSession(providerSessionId);
    } finally {
      this.#compactingSessions.delete(globalSessionId);
    }
  }

  public async providerConnections(): Promise<readonly ProviderConnection[]> {
    return await Promise.all([...this.#adapters.values()].map(async (adapter): Promise<ProviderConnection> => {
      try {
        const detection = await adapter.detect();
        if (!detection.available) {
          const error = this.providerUnavailableError(adapter, detection);
          return {
            providerId: adapter.providerId,
            displayName: adapter.displayName,
            state: "offline",
            detected: false,
            authenticated: null,
            capabilities: this.unavailableProviderCapabilities(),
            lastError: providerErrorFromUnknown(adapter.providerId, error),
          };
        }
        const [auth, capabilities] = await Promise.all([adapter.getAuthStatus(), adapter.getCapabilities()]);
        const connected = this.#subscribedProviders.has(adapter.providerId);
        const connectionError = this.#providerConnectionErrors.get(adapter.providerId);
        return {
          providerId: adapter.providerId,
          displayName: adapter.displayName,
          state: connected ? "online" : "offline",
          detected: true,
          authenticated: auth.authenticated,
          capabilities,
          ...(detection.version !== undefined ? { nativeVersion: detection.version } : {}),
          ...(!connected ? {
            lastError: connectionError ?? providerErrorFromUnknown(adapter.providerId, new ProviderAdapterError(
              adapter.providerId,
              "PROVIDER_DISCONNECTED",
              `${adapter.displayName} is detected but its bridge event subscription is not connected.`,
              true,
            )),
          } : {}),
        };
      } catch (error) {
        return {
          providerId: adapter.providerId,
          displayName: adapter.displayName,
          state: "offline",
          detected: false,
          authenticated: null,
          capabilities: this.unavailableProviderCapabilities(),
          lastError: providerErrorFromUnknown(adapter.providerId, error),
        };
      }
    }));
  }

  public async refresh(): Promise<RefreshResult> {
    this.assertActive();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => this.connectProvider(adapter)));
    const result = await this.#refresh.refresh();
    this.restoreDelegationLinks();
    this.restoreSessionTransferLinks();
    this.reconcileDelegationTimer();
    return { ...result, sessions: this.sessions() };
  }

  public sessions(): readonly RemoteSession[] {
    return this.#cache.all().filter((session) => !this.#internalSessionIds.has(session.id));
  }

  public async visionProxyTargets(): Promise<readonly VisionProxyTarget[]> {
    this.assertActive();
    const targets = await Promise.all([...this.#adapters.values()].map(async (adapter): Promise<VisionProxyTarget | null> => {
      try {
        if (adapter.sessionCreationFeatures?.hiddenDeveloperInstructions !== true || adapter.listModels === undefined) return null;
        const capabilities = await adapter.getCapabilities();
        if (!capabilities.createSession || !capabilities.sendMessage || !capabilities.modelEnumeration) return null;
        const models = (await adapter.listModels()).filter((model) => model.inputModalities?.includes("image") === true);
        return models.length === 0 ? null : { providerId: adapter.providerId, displayName: adapter.displayName, models };
      } catch {
        return null;
      }
    }));
    return targets.filter((target): target is VisionProxyTarget => target !== null);
  }

  public async visionProxyStatus(sessionId: string): Promise<VisionProxyStatus> {
    const session = this.requirePrimarySession(sessionId);
    const runtime = this.#visionProxies.get(sessionId);
    return {
      sessionId,
      ...(session.modelId !== undefined ? { primaryModelId: session.modelId } : {}),
      primaryModelSupportsImageInput: await this.primaryModelImageSupport(session),
      configured: runtime?.selection ?? null,
      ...(runtime?.helperSessionId !== undefined ? { helperSessionId: runtime.helperSessionId } : {}),
    };
  }

  public async configureVisionProxy(sessionId: string, selection: VisionProxySelection | null): Promise<VisionProxyStatus> {
    this.assertActive();
    this.requirePrimarySession(sessionId);
    if (selection === null) {
      this.#visionProxies.delete(sessionId);
      return await this.visionProxyStatus(sessionId);
    }
    await this.validateVisionProxySelection(selection);
    const previous = this.#visionProxies.get(sessionId);
    this.#visionProxies.set(sessionId, {
      selection,
      ...(sameVisionSelection(previous?.selection, selection) && previous?.helperSessionId !== undefined
        ? { helperSessionId: previous.helperSessionId }
        : {}),
      attachments: previous?.attachments ?? new Map(),
    });
    return await this.visionProxyStatus(sessionId);
  }

  public async askVisionProxy(
    sessionId: string,
    question: string,
    attachments?: readonly MessageAttachment[],
  ): Promise<{ readonly observation: string; readonly helperSessionId: string }> {
    const runtime = this.#visionProxies.get(sessionId);
    if (runtime === undefined) throw new Error("No visual-support model is configured for this session");
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length === 0 || trimmedQuestion.length > 8_000) throw new Error("The visual question must contain between 1 and 8000 characters");
    const images = attachments?.length ? attachments : [...runtime.attachments.values()];
    if (images.length === 0) throw new Error("Attach an image before asking visual support");
    const helper = await this.ensureVisionHelperSession(sessionId, runtime);
    const before = await this.requireAdapter(runtime.selection.providerId).getMessages(helper.providerSessionId);
    await this.requireAdapter(runtime.selection.providerId).sendMessage(helper.providerSessionId, {
      requestId: `eyes_${randomUUID()}`,
      content: trimmedQuestion,
      modelId: runtime.selection.modelId,
      ...(runtime.selection.reasoningEffort !== undefined ? { reasoningEffort: runtime.selection.reasoningEffort } : {}),
      attachments: images,
      metadata: { internalPurpose: "vision_proxy", parentSessionId: sessionId },
    });
    const observation = await this.waitForVisionObservation(runtime.selection.providerId, helper.providerSessionId, before);
    return { observation, helperSessionId: helper.id };
  }

  public async openSession(globalSessionId: string, cursor?: string, limit = 40): Promise<OpenSessionResult> {
    this.assertActive();
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(globalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    const cached = this.#cache.get(globalSessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 80));
    if (cursor !== undefined) {
      const snapshot = this.#messageSnapshots.get(globalSessionId);
      if (snapshot === undefined) throw new Error("Message history page expired; reopen the session");
      this.touchMessageSnapshot(globalSessionId, snapshot);
      const page = messagePage(snapshot.messages, cursor, boundedLimit);
      return { session: cached ?? await adapter.getSession(providerSessionId), ...page };
    }

    const generation = this.#messageSnapshotGenerations.get(globalSessionId) ?? 0;
    const snapshot = this.#messageSnapshots.get(globalSessionId);
    if (cached !== undefined && snapshot !== undefined && snapshot.generation === generation && snapshot.freshUntil > Date.now()) {
      this.touchMessageSnapshot(globalSessionId, snapshot);
      return { session: cached, ...messagePage(snapshot.messages, undefined, boundedLimit) };
    }

    const existingLoad = this.#openSessionLoads.get(globalSessionId);
    const load = existingLoad?.generation === generation
      ? existingLoad.promise
      : this.loadOpenSession(globalSessionId, providerSessionId, adapter, cached, generation);
    if (existingLoad?.generation !== generation) {
      const record: OpenSessionLoad = { generation, promise: load };
      this.#openSessionLoads.set(globalSessionId, record);
      void load.finally(() => {
        if (this.#openSessionLoads.get(globalSessionId) === record) this.#openSessionLoads.delete(globalSessionId);
      }).catch(() => undefined);
    }
    const opened = await load;
    return { session: opened.session, ...messagePage(opened.messages, undefined, boundedLimit) };
  }

  private async loadOpenSession(
    globalSessionId: string,
    providerSessionId: string,
    adapter: AgentProviderAdapter,
    cached: RemoteSession | undefined,
    generation: number,
  ): Promise<{ readonly session: RemoteSession; readonly messages: readonly RemoteMessage[] }> {
    const [session, providerMessages] = await Promise.all([
      cached === undefined ? adapter.getSession(providerSessionId) : Promise.resolve(cached),
      adapter.getMessages(providerSessionId),
    ]);
    if (cached === undefined) this.#cache.upsert(session);
    this.restoreSessionTransferLinks();
    const resolvedSession = this.#cache.get(globalSessionId) ?? session;
    const providerVisible = clientVisibleBranchMessages(clientVisibleHandoffMessages(providerMessages));
    const copied = resolvedSession.relationship?.kind === "branch" && resolvedSession.relationship.strategy === "transcript_bootstrap"
      ? this.#branchCopies.get(globalSessionId)
      : undefined;
    const messages = copied === undefined
      ? providerVisible
      : [...copyBranchMessages(copied, globalSessionId), ...providerVisible];
    this.cacheMessageSnapshot(globalSessionId, messages, generation);
    return { session: resolvedSession, messages };
  }

  private cacheMessageSnapshot(sessionId: string, messages: readonly RemoteMessage[], generation: number): void {
    const current = this.#messageSnapshots.get(sessionId);
    if (current !== undefined && current.generation > generation) return;
    this.#messageSnapshots.delete(sessionId);
    this.#messageSnapshots.set(sessionId, {
      messages,
      generation,
      freshUntil: generation === (this.#messageSnapshotGenerations.get(sessionId) ?? 0)
        ? Date.now() + messageSnapshotTtlMs
        : 0,
    });
    while (this.#messageSnapshots.size > maxMessageSnapshots) {
      const oldest = this.#messageSnapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#messageSnapshots.delete(oldest);
    }
  }

  private touchMessageSnapshot(sessionId: string, snapshot: MessageSnapshotRecord): void {
    this.#messageSnapshots.delete(sessionId);
    this.#messageSnapshots.set(sessionId, snapshot);
  }

  private invalidateMessageSnapshot(sessionId: string): void {
    this.#messageSnapshotGenerations.set(sessionId, (this.#messageSnapshotGenerations.get(sessionId) ?? 0) + 1);
  }

  public async listChildSessions(parentGlobalSessionId: string): Promise<readonly RemoteSession[]> {
    this.assertActive();
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(parentGlobalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    const capabilities = await adapter.getCapabilities();
    const delegatedChildren = [...this.#delegations.values()]
      .filter((runtime) => runtime.task.parentSessionId === parentGlobalSessionId)
      .flatMap((runtime) => runtime.task.children)
      .map((child) => child.sessionId === undefined ? undefined : this.#cache.get(child.sessionId))
      .filter((session): session is RemoteSession => session !== undefined);
    const visionHelperId = this.#visionProxies.get(parentGlobalSessionId)?.helperSessionId;
    const visionHelpers = visionHelperId === undefined
      ? []
      : [this.#cache.get(visionHelperId)].filter((session): session is RemoteSession => session !== undefined);
    if (!capabilities.sessionRelationships && delegatedChildren.length === 0 && visionHelpers.length === 0) {
      throw new Error(`${providerId} does not support child-session relationships`);
    }
    const nativeChildren = capabilities.sessionRelationships
      ? (await collectAllSessionPages(adapter, { parentProviderSessionId: providerSessionId, limit: 100 })).sessions
          .filter((session) => session.parentSessionId === parentGlobalSessionId)
      : [];
    const children = [...new Map([...nativeChildren, ...delegatedChildren, ...visionHelpers].map((session) => [session.id, session])).values()];
    this.#cache.reconcileChildren(parentGlobalSessionId, children);
    return children.map((session) => this.#cache.get(session.id) ?? session);
  }

  public delegations(parentSessionId?: string): readonly DelegationTask[] {
    return [...this.#delegations.values()]
      .map((runtime) => runtime.task)
      .filter((task) => parentSessionId === undefined || task.parentSessionId === parentSessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async startDelegation(
    parentSessionId: string,
    prompt: string,
    targets: readonly DelegationTarget[],
  ): Promise<DelegationTask> {
    this.assertActive();
    const parent = this.#cache.get(parentSessionId);
    if (parent === undefined) throw new Error("Parent session is not loaded on this bridge");
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) throw new Error("Delegation prompt must not be empty");
    if (targets.length === 0 || targets.length > 4) throw new Error("Choose between one and four delegated harnesses");
    const unique = new Set(targets.map((target) => `${target.providerId}\u0000${target.modelId ?? ""}\u0000${target.reasoningEffort ?? ""}`));
    if (unique.size !== targets.length) throw new Error("Delegated harness selections must be unique");
    if (targets.some((target) => target.providerId === parent.providerId)) {
      throw new Error("/mesh targets must use a different harness from the parent session");
    }
    for (const target of targets) {
      const adapter = this.requireAdapter(target.providerId);
      const capabilities = await adapter.getCapabilities();
      if (!capabilities.createSession || !capabilities.sendMessage) {
        throw new Error(`${target.providerId} cannot create delegated sessions`);
      }
    }

    const now = new Date().toISOString();
    const id = `delegation_${randomUUID()}`;
    const runtime: DelegationRuntime = {
      task: {
        id,
        parentSessionId,
        prompt: trimmedPrompt,
        state: "spawning",
        createdAt: now,
        updatedAt: now,
        children: [],
      },
      sawWorking: new Set<string>(),
      resultsReady: false,
      synthesisDispatched: false,
    };
    this.#delegations.set(id, runtime);
    this.appendDelegationEvent("delegation.started", runtime.task);

    const children = await Promise.all(targets.map(async (target, index): Promise<DelegationChild> => {
      const childId = `${id}_child_${index + 1}`;
      try {
        const adapter = this.requireAdapter(target.providerId);
        const instruction = delegatedWorkerInstruction(trimmedPrompt, parent, adapter.displayName);
        const created = await adapter.createSession({
          workingDirectory: parent.workingDirectory ?? parent.project ?? process.cwd(),
          title: `Delegated: ${trimmedPrompt.slice(0, 72)}`,
          ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
          ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
          firstInstruction: instruction,
          metadata: { delegationId: id, parentSessionId, role: "cross_harness_delegate" },
        });
        const linked: RemoteSession = {
          ...created,
          state: "working",
          lastActivityAt: new Date().toISOString(),
          parentSessionId,
          agentNickname: `${adapter.displayName} delegate`,
          agentRole: "cross_harness_delegate",
          ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
          ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
        };
        this.#cache.upsert(linked);
        runtime.sawWorking.add(linked.id);
        return {
          id: childId,
          providerId: target.providerId,
          sessionId: linked.id,
          ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
          ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
          state: "working",
        };
      } catch (error) {
        return {
          id: childId,
          providerId: target.providerId,
          ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
          ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    runtime.task = {
      ...runtime.task,
      state: children.every((child) => child.state === "failed") ? "failed" : "working",
      updatedAt: new Date().toISOString(),
      children,
      ...(children.every((child) => child.state === "failed") ? { error: "No delegated harness could be started" } : {}),
    };
    this.appendDelegationEvent(runtime.task.state === "failed" ? "delegation.failed" : "delegation.updated", runtime.task);
    if (runtime.task.state !== "failed") {
      try {
        await this.startParentDelegationTurn(runtime.task, parent);
      } catch (error) {
        runtime.task = {
          ...runtime.task,
          updatedAt: new Date().toISOString(),
          error: `Parent background turn could not be started: ${error instanceof Error ? error.message : String(error)}`,
        };
        this.appendDelegationEvent("delegation.updated", runtime.task);
      }
    }
    this.reconcileDelegationTimer();
    void this.pumpDelegation(id);
    return runtime.task;
  }

  public async executeClientTool(parentSessionId: string, tool: string, input: JsonObject): Promise<JsonObject> {
    if (tool === "ask_eyes") {
      const result = await this.askVisionProxy(parentSessionId, requiredMeshString(input, "question"));
      return { observation: result.observation, helperSessionId: result.helperSessionId };
    }
    return await this.executeMeshTool(parentSessionId, tool, input);
  }

  public async executeMeshTool(parentSessionId: string, tool: string, input: JsonObject): Promise<JsonObject> {
    this.assertActive();
    this.assertSessionHost(parentSessionId);
    if (this.#cache.get(parentSessionId) === undefined) throw new Error("Parent session is not loaded on this bridge");
    if (tool === "mesh_list_children") return { children: this.meshChildren(parentSessionId) };
    if (tool === "mesh_message_child") {
      const childSessionId = requiredMeshString(input, "child_session_id");
      const message = requiredMeshString(input, "message");
      this.requireMeshChild(parentSessionId, childSessionId);
      const child = this.#cache.get(childSessionId);
      if (child === undefined) throw new Error("Delegated child session is not loaded");
      const requestId = `mesh_followup_${randomUUID()}`;
      if (child.state === "working") {
        const { providerId } = this.assertSessionHost(childSessionId);
        const adapter = this.requireAdapter(providerId);
        const capabilities = await adapter.getCapabilities();
        if (capabilities.steering && adapter.steerMessage !== undefined) {
          await this.steerMessage(childSessionId, { requestId, content: message });
          return { delivery: "steered", childSessionId };
        }
        const queued = await this.enqueueMessage(childSessionId, { requestId, content: message });
        return { delivery: "queued", childSessionId, queuedMessageId: queued.id };
      }
      await this.sendMessage(childSessionId, { requestId, content: message });
      this.#cache.updateState(childSessionId, "working", false);
      void this.pumpDelegationsForSession(childSessionId);
      return { delivery: "sent", childSessionId };
    }
    if (tool === "mesh_wait") {
      const children = this.meshChildIds(parentSessionId, input.child_session_ids);
      const timeoutSeconds = optionalMeshInteger(input.timeout_seconds, 120, 1, 300);
      const deadline = Date.now() + timeoutSeconds * 1_000;
      while (Date.now() < deadline && children.some((id) => this.#cache.get(id)?.state === "working")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const states = children.map((id) => ({ sessionId: id, state: this.#cache.get(id)?.state ?? "unknown" }));
      return { timedOut: states.some((entry) => entry.state === "working"), children: states };
    }
    if (tool === "mesh_read_result") {
      const childSessionId = requiredMeshString(input, "child_session_id");
      const child = this.requireMeshChild(parentSessionId, childSessionId);
      const { providerSessionId } = this.assertSessionHost(childSessionId);
      const messages = await this.requireAdapter(child.providerId).getMessages(providerSessionId);
      const transcript = messages.slice(-8).flatMap((message) => {
        const text = message.parts.flatMap((part) => part.type === "text" || part.type === "reasoning" ? [part.text.trim()] : []).filter(Boolean).join("\n");
        return text.length === 0 ? [] : [{ role: message.role, text: text.slice(0, 8_000), status: message.status }];
      });
      return {
        childSessionId,
        providerId: child.providerId,
        state: this.#cache.get(childSessionId)?.state ?? child.state,
        latestAssistantOutput: latestAssistantOutput(messages) ?? null,
        transcript,
      };
    }
    throw new Error(`Unknown mesh tool ${tool}`);
  }

  private meshChildren(parentSessionId: string): JsonObject[] {
    return this.delegations(parentSessionId).flatMap((task) => task.children.map((child) => ({
      delegationId: task.id,
      childSessionId: child.sessionId ?? null,
      providerId: child.providerId,
      state: child.sessionId === undefined ? child.state : this.#cache.get(child.sessionId)?.state ?? child.state,
      modelId: child.modelId ?? null,
      reasoningEffort: child.reasoningEffort ?? null,
      error: child.error ?? null,
    })));
  }

  private meshChildIds(parentSessionId: string, requested: unknown): string[] {
    const available = this.delegations(parentSessionId).flatMap((task) => task.children.flatMap((child) => child.sessionId === undefined ? [] : [child.sessionId]));
    if (requested === undefined) return available;
    if (!Array.isArray(requested) || !requested.every((entry) => typeof entry === "string")) throw new Error("child_session_ids must be an array of child session IDs");
    for (const childSessionId of requested) this.requireMeshChild(parentSessionId, childSessionId);
    return [...requested];
  }

  private requireMeshChild(parentSessionId: string, childSessionId: string): DelegationChild {
    const child = this.delegations(parentSessionId).flatMap((task) => task.children).find((entry) => entry.sessionId === childSessionId);
    if (child === undefined) throw new Error("That session is not a delegated child of this parent");
    return child;
  }

  private async startParentDelegationTurn(task: DelegationTask, parent: RemoteSession): Promise<void> {
    const request = {
      requestId: `delegation_started_${task.id}`,
      content: delegationStartedInstruction(task, this.#clientTooling !== undefined),
      metadata: { delegationId: task.id, kind: "delegation_started" },
    } as const;
    const currentState = this.#cache.get(parent.id)?.state ?? parent.state;
    if (currentState === "working" || currentState === "needs_approval" || currentState === "needs_input" || currentState === "disconnected" || currentState === "unknown") {
      await this.enqueueMessage(parent.id, request);
      return;
    }
    await this.sendMessage(parent.id, request);
    this.#cache.updateState(parent.id, "working", false);
  }

  private hasQueuedParentDelegationTurn(task: DelegationTask): boolean {
    const marker = `[[UAR_MESH_STARTED:${task.id}]]`;
    return [...this.#queuedMessages.values()].some(({ view }) =>
      view.sessionId === task.parentSessionId && view.state !== "failed" && view.content.startsWith(marker));
  }

  public async createSession(providerId: string, options: CreateSessionOptions): Promise<RemoteSession> {
    this.assertActive();
    const session = await this.requireAdapter(providerId).createSession({
      ...options,
      workingDirectory: options.workingDirectory.trim() || process.cwd(),
    });
    this.#cache.upsert(session);
    return session;
  }

  private restoreSessionTransferRuntime(record: SessionTransferRecord): void {
    this.#sessionTransfers.set(record.sessionId, record);
    if (record.relationship.kind === "handoff" && record.pending && record.summary !== undefined) {
      this.#pendingContextHandoffs.set(record.sessionId, {
        summary: record.summary,
        relationship: record.relationship,
        ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
      });
    }
    if (record.relationship.kind === "branch") {
      if (record.copiedMessages !== undefined) this.#branchCopies.set(record.sessionId, record.copiedMessages);
      if (record.pending && record.bootstrap !== undefined) {
        this.#pendingBranchBootstraps.set(record.sessionId, { bootstrap: record.bootstrap, relationship: record.relationship });
      }
    }
  }

  private rememberSessionTransfer(record: SessionTransferRecord): void {
    this.#sessionTransfers.set(record.sessionId, record);
    while (this.#sessionTransfers.size > maxPersistedSessionTransfers) {
      const oldestSessionId = this.#sessionTransfers.keys().next().value as string | undefined;
      if (oldestSessionId === undefined) break;
      this.#sessionTransfers.delete(oldestSessionId);
      this.#pendingContextHandoffs.delete(oldestSessionId);
      this.#pendingBranchBootstraps.delete(oldestSessionId);
      this.#branchCopies.delete(oldestSessionId);
    }
    this.#onSessionTransfersChange?.([...this.#sessionTransfers.values()]);
  }

  private completeSessionTransferBootstrap(sessionId: string): void {
    const record = this.#sessionTransfers.get(sessionId);
    if (record === undefined || !record.pending) return;
    const completed: SessionTransferRecord = {
      sessionId: record.sessionId,
      relationship: record.relationship,
      pending: false,
      ...(record.summary !== undefined ? { summary: record.summary } : {}),
      ...(record.copiedMessages !== undefined ? { copiedMessages: record.copiedMessages } : {}),
    };
    this.#sessionTransfers.set(sessionId, completed);
    this.#onSessionTransfersChange?.([...this.#sessionTransfers.values()]);
  }

  private restoreSessionTransferLinks(): void {
    for (const record of this.#sessionTransfers.values()) {
      const session = this.#cache.get(record.sessionId);
      if (session === undefined) continue;
      try {
        const current = parseGlobalSessionId(record.sessionId);
        const source = parseGlobalSessionId(record.relationship.sourceSessionId);
        if (current.hostId !== this.config.hostId || source.hostId !== this.config.hostId || current.providerId !== source.providerId) continue;
      } catch {
        continue;
      }
      const nativeMetadata: JsonObject = record.relationship.kind === "handoff" ? {
        ...(record.summary !== undefined ? { tethoqHandoffSummary: record.summary } : {}),
        ...(record.prompt !== undefined ? { tethoqHandoffPrompt: record.prompt } : {}),
        tethoqHandoffPending: record.pending,
      } : {
        ...(record.bootstrap !== undefined ? { tethoqBranchBootstrap: record.bootstrap } : {}),
        tethoqBranchPending: record.pending,
      };
      this.#cache.upsert({
        ...session,
        relationship: record.relationship,
        ...(record.summary !== undefined ? { contextHandoffSummary: record.summary } : {}),
        nativeMetadata: { ...session.nativeMetadata, ...transferMetadata(record.relationship), ...nativeMetadata },
      });
    }
  }

  public async contextHandoff(sourceSessionId: string, prompt?: string): Promise<ContextHandoffResult> {
    this.assertActive();
    const { adapter, source, messages } = await this.transferSource(sourceSessionId);
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.createSession || !capabilities.sendMessage) {
      throw new Error(`${adapter.displayName} cannot create a context handoff`);
    }
    const summary = handoffSummary(source, messages);
    const relationship: SessionRelationship = {
      kind: "handoff",
      sourceSessionId,
      strategy: "summary_bootstrap",
    };
    const created = await adapter.createSession({
      workingDirectory: transferWorkingDirectory(source),
      title: `Handoff: ${source.title}`.slice(0, 120),
      ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
      ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
      metadata: transferMetadata(relationship),
    });
    const handoffMetadata: JsonObject = {
      tethoqHandoffSummary: summary,
      tethoqHandoffPending: true,
      ...(prompt !== undefined ? { tethoqHandoffPrompt: prompt } : {}),
    };
    const session = { ...transferredSession(created, source, relationship, handoffMetadata), contextHandoffSummary: summary };
    assertFreshTransferSession(source, session);
    this.#cache.upsert(session);
    this.#pendingContextHandoffs.set(session.id, {
      summary,
      relationship,
      ...(prompt !== undefined ? { prompt } : {}),
    });
    this.rememberSessionTransfer({
      sessionId: session.id,
      relationship,
      pending: true,
      summary,
      ...(prompt !== undefined ? { prompt } : {}),
    });
    return { summary, session, ...(prompt !== undefined ? { prompt } : {}) };
  }

  public async branchSession(sourceSessionId: string, prompt?: string): Promise<BranchSessionResult> {
    this.assertActive();
    const { adapter, source, messages } = await this.transferSource(sourceSessionId);
    const native = adapter.branchSession !== undefined;
    const strategy = native ? "native" as const : "transcript_bootstrap" as const;
    const relationship: SessionRelationship = { kind: "branch", sourceSessionId, strategy };
    const capabilities = await adapter.getCapabilities();
    if ((!native && (!capabilities.createSession || !capabilities.sendMessage)) || (prompt !== undefined && !capabilities.sendMessage)) {
      throw new Error(`${adapter.displayName} cannot create a conversation branch`);
    }
    const fallback = native ? undefined : branchBootstrap(source, messages);
    const created = native
      ? await adapter.branchSession!(source.providerSessionId)
      : await adapter.createSession({
          workingDirectory: transferWorkingDirectory(source),
          title: `Branch: ${source.title}`.slice(0, 120),
          ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
          ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
          metadata: transferMetadata(relationship),
        });
    const branchMetadata: JsonObject = fallback === undefined ? {} : {
      tethoqBranchBootstrap: fallback.content,
      tethoqBranchPending: true,
    };
    const session = transferredSession(created, source, relationship, branchMetadata);
    assertFreshTransferSession(source, session);
    this.#cache.upsert(session);
    if (fallback !== undefined) {
      this.#pendingBranchBootstraps.set(session.id, { bootstrap: fallback.content, relationship });
      this.#branchCopies.set(session.id, messages);
    }
    this.rememberSessionTransfer({
      sessionId: session.id,
      relationship,
      pending: fallback !== undefined,
      ...(fallback !== undefined ? {
        bootstrap: fallback.content,
        copiedMessages: persistableBranchMessages(messages),
      } : {}),
    });
    if (prompt !== undefined) {
      await this.sendMessage(session.id, {
        requestId: `branch_${randomUUID()}`,
        content: prompt,
        ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
        ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
        metadata: transferMetadata(relationship),
      });
    }
    return { session, strategy, copiedMessageCount: messages.length };
  }

  private async transferSource(sourceSessionId: string): Promise<{
    readonly adapter: AgentProviderAdapter;
    readonly source: RemoteSession;
    readonly messages: readonly RemoteMessage[];
  }> {
    const { providerId, providerSessionId } = this.assertSessionHost(sourceSessionId);
    const adapter = this.requireAdapter(providerId);
    const cached = this.#cache.get(sourceSessionId);
    const [providerSession, providerMessages] = await Promise.all([
      cached === undefined ? adapter.getSession(providerSessionId) : Promise.resolve(cached),
      adapter.getMessages(providerSessionId),
    ]);
    this.#cache.upsert(providerSession);
    this.restoreSessionTransferLinks();
    const source = this.#cache.get(sourceSessionId) ?? providerSession;
    const providerVisible = clientVisibleBranchMessages(clientVisibleHandoffMessages(providerMessages));
    const copied = source.relationship?.kind === "branch" && source.relationship.strategy === "transcript_bootstrap"
      ? this.#branchCopies.get(sourceSessionId)
      : undefined;
    const messages = copied === undefined ? providerVisible : [...copyBranchMessages(copied, sourceSessionId), ...providerVisible];
    return { adapter, source, messages };
  }

  public async sendMessage(globalSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.assertActive();
    if (this.pendingContextHandoff(globalSessionId) !== undefined || this.pendingBranchBootstrap(globalSessionId) !== undefined) {
      return await this.withPendingHandoffSendLock(globalSessionId, async () =>
        await this.dispatchMessage(globalSessionId, request));
    }
    return await this.dispatchMessage(globalSessionId, request);
  }

  public async sendUploadedMessage(
    globalSessionId: string,
    request: Omit<SendMessageRequest, "attachments">,
    attachmentIds: readonly string[],
  ): Promise<SendMessageResult> {
    const consumption = this.#attachmentUploads.consume(attachmentIds);
    try {
      const result = await this.sendMessage(globalSessionId, {
        ...request,
        ...(consumption.attachments.length > 0 ? { attachments: consumption.attachments } : {}),
      });
      consumption.commit();
      return result;
    } catch (error) {
      consumption.release();
      throw error;
    }
  }

  private async dispatchMessage(globalSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const previous = this.#sendLedger.get(request.requestId);
    if (previous !== undefined) return previous;
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(globalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const pending = this.pendingContextHandoff(globalSessionId);
    const pendingBranch = this.pendingBranchBootstrap(globalSessionId);
    const contextualRequest: SendMessageRequest = pending !== undefined
      ? {
          ...request,
          content: handoffBootstrap(pending.summary, request.content, pending.prompt),
          metadata: {
            ...(request.metadata ?? {}),
            ...transferMetadata(pending.relationship),
            handoffBootstrapApplied: true,
          },
        }
      : pendingBranch !== undefined
        ? {
            ...request,
            content: branchBootstrapWithUserRequest(pendingBranch.bootstrap, request.content),
            metadata: {
              ...(request.metadata ?? {}),
              ...transferMetadata(pendingBranch.relationship),
              branchBootstrapApplied: true,
            },
          }
        : request;
    this.assertAttachmentProvider(providerId, contextualRequest.attachments);
    const routedRequest = await this.routeVisionAttachments(globalSessionId, contextualRequest);
    const result = await this.requireAdapter(providerId).sendMessage(providerSessionId, routedRequest);
    this.#sendLedger.set(request.requestId, result);
    if (pending !== undefined && result.accepted) {
      this.#pendingContextHandoffs.delete(globalSessionId);
      this.#cache.updateNativeMetadata(globalSessionId, { tethoqHandoffPending: false });
      this.completeSessionTransferBootstrap(globalSessionId);
    }
    if (pendingBranch !== undefined && result.accepted) {
      this.#pendingBranchBootstraps.delete(globalSessionId);
      this.#cache.updateNativeMetadata(globalSessionId, { tethoqBranchPending: false });
      this.completeSessionTransferBootstrap(globalSessionId);
    }
    this.invalidateMessageSnapshot(globalSessionId);
    return result;
  }

  private pendingContextHandoff(globalSessionId: string): PendingContextHandoff | undefined {
    const current = this.#pendingContextHandoffs.get(globalSessionId);
    if (current !== undefined) return current;
    const session = this.#cache.get(globalSessionId);
    if (session?.relationship?.kind !== "handoff"
      || session.nativeMetadata.tethoqHandoffPending !== true
      || typeof session.nativeMetadata.tethoqHandoffSummary !== "string") return undefined;
    const recovered: PendingContextHandoff = {
      summary: session.nativeMetadata.tethoqHandoffSummary,
      relationship: session.relationship,
      ...(typeof session.nativeMetadata.tethoqHandoffPrompt === "string"
        ? { prompt: session.nativeMetadata.tethoqHandoffPrompt }
        : {}),
    };
    this.#pendingContextHandoffs.set(globalSessionId, recovered);
    return recovered;
  }

  private pendingBranchBootstrap(globalSessionId: string): PendingBranchBootstrap | undefined {
    const current = this.#pendingBranchBootstraps.get(globalSessionId);
    if (current !== undefined) return current;
    const session = this.#cache.get(globalSessionId);
    if (session?.relationship?.kind !== "branch"
      || session.relationship.strategy !== "transcript_bootstrap"
      || session.nativeMetadata.tethoqBranchPending !== true
      || typeof session.nativeMetadata.tethoqBranchBootstrap !== "string") return undefined;
    const recovered: PendingBranchBootstrap = {
      bootstrap: session.nativeMetadata.tethoqBranchBootstrap,
      relationship: session.relationship,
    };
    this.#pendingBranchBootstraps.set(globalSessionId, recovered);
    return recovered;
  }

  private async withPendingHandoffSendLock<T>(globalSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pendingHandoffSends.get(globalSessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#pendingHandoffSends.set(globalSessionId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#pendingHandoffSends.get(globalSessionId) === current) this.#pendingHandoffSends.delete(globalSessionId);
    }
  }

  public beginAttachmentUpload(input: BeginAttachmentUpload) {
    this.assertActive();
    return this.#attachmentUploads.begin(input);
  }

  public appendAttachmentChunk(uploadId: string, offset: number, dataBase64: string) {
    this.assertActive();
    return this.#attachmentUploads.append(uploadId, offset, dataBase64);
  }

  public completeAttachmentUpload(uploadId: string) {
    this.assertActive();
    return this.#attachmentUploads.complete(uploadId);
  }

  public discardAttachmentUpload(uploadId: string): boolean {
    return this.#attachmentUploads.discard(uploadId);
  }

  public async transcribeDictation(
    attachmentId: string,
    dictionary: readonly string[],
    sourceId: string = openAiTranscriptionSourceId,
  ): Promise<{ readonly text: string }> {
    this.assertActive();
    const consumption = this.#attachmentUploads.consume([attachmentId]);
    const [audio] = consumption.attachments;
    if (audio === undefined) throw new Error("Dictation audio is missing");
    try {
      const result = await this.#transcriptionSources.transcribe(sourceId, audio, { dictionary });
      consumption.commit();
      return result;
    } catch (error) {
      consumption.release();
      throw error;
    }
  }

  public transcriptionSources() {
    this.assertActive();
    return this.#transcriptionSources.list();
  }

  public queuedMessages(sessionId?: string): readonly QueuedMessage[] {
    return [...this.#queuedMessages.values()]
      .map((record) => record.view)
      .filter((message) => sessionId === undefined || message.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async enqueueMessage(
    globalSessionId: string,
    input: Omit<SendMessageRequest, "attachments"> & { readonly attachmentIds?: readonly string[] },
  ): Promise<QueuedMessage> {
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const session = this.#cache.get(globalSessionId);
    if (session === undefined) throw new Error("Session is not loaded on this bridge");
    const adapter = this.requireAdapter(providerId);
    if (adapter.enqueueQueuedMessage !== undefined && (input.attachmentIds?.length ?? 0) === 0) {
      if (session.workingDirectory === undefined) throw new Error("This session does not expose a working directory for its desktop queue");
      const message = await adapter.enqueueQueuedMessage(providerSessionId, {
        requestId: input.requestId,
        content: input.content,
        workingDirectory: session.workingDirectory,
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      });
      const view = this.providerQueuedMessage(providerId, message);
      const previous = this.#queuedMessages.get(view.id)?.view;
      this.#queuedMessages.set(view.id, { view, providerOwned: true, providerMessageId: message.id });
      if (previous === undefined) this.appendQueueEvent("message.queued", view);
      else if (JSON.stringify(previous) !== JSON.stringify(view)) this.appendQueueEvent("message.queue_updated", view);
      return view;
    }
    const consumption = this.#attachmentUploads.consume(input.attachmentIds ?? []);
    const attachments = consumption.attachments;
    try {
      this.assertAttachmentProvider(providerId, attachments);
    } catch (error) {
      consumption.release();
      throw error;
    }
    const id = `queued_${randomUUID()}`;
    const request: SendMessageRequest = {
      requestId: input.requestId,
      content: input.content,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const view: QueuedMessage = {
      id,
      sessionId: globalSessionId,
      content: input.content,
      mode: "queue",
      state: "queued",
      createdAt: new Date().toISOString(),
      attachments: attachments.map(({ name, mimeType, byteLength }) => ({ name, mimeType, byteLength })),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    };
    this.#queuedMessages.set(id, { view, request, providerOwned: false });
    this.appendQueueEvent("message.queued", view);
    consumption.commit();
    void this.pumpQueue(globalSessionId);
    return view;
  }

  public async cancelQueuedMessage(messageId: string): Promise<boolean> {
    const record = this.#queuedMessages.get(messageId);
    if (record === undefined || record.view.state === "sending") return false;
    if (record.providerOwned) {
      const { providerId, providerSessionId } = this.assertSessionHost(record.view.sessionId);
      const adapter = this.requireAdapter(providerId);
      if (adapter.cancelQueuedMessage === undefined) return false;
      const cancelled = await adapter.cancelQueuedMessage(providerSessionId, record.providerMessageId ?? messageId);
      if (!cancelled) return false;
      if (!this.#queuedMessages.has(messageId)) return true;
    }
    this.#queuedMessages.delete(messageId);
    this.#events.append({
      type: "message.queue_removed",
      sessionId: record.view.sessionId,
      payload: { messageId, reason: "cancelled" },
    });
    return true;
  }

  public async steerMessage(
    globalSessionId: string,
    input: Omit<SendMessageRequest, "attachments"> & { readonly attachmentIds?: readonly string[] },
  ): Promise<SendMessageResult> {
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const consumption = this.#attachmentUploads.consume(input.attachmentIds ?? []);
    const attachments = consumption.attachments;
    try {
      this.assertAttachmentProvider(providerId, attachments);
    } catch (error) {
      consumption.release();
      throw error;
    }
    const request: SendMessageRequest = {
      requestId: input.requestId,
      content: input.content,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const session = this.#cache.get(globalSessionId);
    if (session?.state !== "working") {
      try {
        const result = await this.sendMessage(globalSessionId, request);
        consumption.commit();
        return result;
      } catch (error) {
        consumption.release();
        throw error;
      }
    }
    const adapter = this.requireAdapter(providerId);
    if (adapter.steerMessage === undefined) {
      consumption.release();
      throw new Error(`${providerId} does not support steering active work`);
    }
    try {
      const result = await adapter.steerMessage(providerSessionId, request);
      this.invalidateMessageSnapshot(globalSessionId);
      consumption.commit();
      return result;
    } catch (error) {
      consumption.release();
      throw error;
    }
  }

  public async editMessage(globalSessionId: string, request: EditMessageRequest): Promise<SendMessageResult> {
    this.assertActive();
    const session = this.#cache.get(globalSessionId);
    if (session === undefined) throw new Error("Session is not loaded on this bridge");
    if (session.state !== "idle" && session.state !== "completed" && session.state !== "failed") {
      throw new Error("Stop the active work before editing a sent message");
    }
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const adapter = this.requireAdapter(providerId);
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.messageEditing || adapter.editMessage === undefined) {
      throw new Error(`${providerId} does not support editing sent messages`);
    }
    const result = await adapter.editMessage(providerSessionId, request);
    this.invalidateMessageSnapshot(globalSessionId);
    this.#cache.updateState(globalSessionId, "working", false);
    return result;
  }

  public async interrupt(globalSessionId: string): Promise<void> {
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(globalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    if (adapter.interrupt === undefined) throw new Error(`${providerId} does not support interruption`);
    await adapter.interrupt(providerSessionId);
  }

  public pendingApprovals() {
    return this.#approvals.list();
  }

  public async respondToApproval(response: ApprovalResponse): Promise<void> {
    const approval = await this.#approvals.resolve(this.config.hostId, response);
    this.#cache.updateState(approval.sessionId, "working", false);
    this.#events.append({
      type: "approval.resolved",
      providerId: approval.providerId,
      sessionId: approval.sessionId,
      payload: { requestId: approval.requestId, choiceId: response.choiceId },
    });
  }

  public pendingUserInputs() {
    return this.#userInputs.list();
  }

  public async respondToUserInput(response: UserInputResponse): Promise<void> {
    const request = await this.#userInputs.resolve(this.config.hostId, response);
    this.#cache.updateState(request.sessionId, "working", false);
  }

  public startPairing(relayUrl?: string, relayToken?: string) {
    return this.#pairing.startPairing({
      ...(relayUrl !== undefined ? { relayUrl } : {}),
      ...(relayToken !== undefined ? { relayToken } : {}),
    });
  }

  public setRelayConnected(connected: boolean): void {
    if (this.#relayConnected === connected) return;
    this.#relayConnected = connected;
    this.#events.append({ type: connected ? "host.connected" : "host.disconnected", payload: { transport: "relay" } });
  }

  public confirmPairing(input: Parameters<PairingManager["confirmPairing"]>[0]) {
    const credential = this.#pairing.confirmPairing(input);
    this.#onPairingConfirmed?.();
    return credential;
  }

  public pairedDevices() {
    return this.#pairing.listDevices();
  }

  public revokeDevice(credentialId: string): boolean {
    return this.#pairing.revoke(credentialId);
  }

  public verifyDeviceAction<T extends JsonObject>(signed: SignedDeviceAction<T>): T {
    return this.#deviceVerifier.verify(signed).action;
  }

  public eventsSince(sequence: number): readonly AgentEvent[] {
    return this.#events.since(sequence);
  }

  public eventReplaySince(sequence: number): EventReplaySlice {
    return this.#events.replaySince(sequence);
  }

  public latestSequence(): number {
    return this.#events.latestSequence();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#delegationTimer !== undefined) clearInterval(this.#delegationTimer);
    this.#delegationTimer = undefined;
    this.#events.append({ type: "host.disconnected", payload: {} });
    await Promise.allSettled(this.#subscriptions.map((subscription) => subscription.unsubscribe()));
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.dispose()));
    this.#subscriptions.length = 0;
    this.#messageSnapshots.clear();
    this.#messageSnapshotGenerations.clear();
    this.#openSessionLoads.clear();
    this.#pendingContextHandoffs.clear();
    this.#pendingBranchBootstraps.clear();
    this.#branchCopies.clear();
    this.#pendingHandoffSends.clear();
    this.#providerConnectionErrors.clear();
    this.#queuedMessages.clear();
    this.#queuePumps.clear();
    this.#delegations.clear();
    this.#visionProxies.clear();
    this.#internalSessionIds.clear();
    this.#internalSessionCreations.clear();
  }

  private async receiveProviderEvent(event: ProviderEvent): Promise<void> {
    const internalCreation = this.#internalSessionCreations.get(event.providerId);
    if (internalCreation !== undefined) {
      internalCreation.events.push(event);
      return;
    }
    if (!this.#deduper.accept(`${event.providerId}:${event.eventId}`)) return;
    if (event.type === "message.queue_updated" && Array.isArray(event.payload.messages)) {
      this.syncProviderQueue(event.providerId, event.payload.messages);
      return;
    }
    const globalSessionId = event.providerSessionId === undefined ? undefined : makeGlobalSessionId(this.config.hostId, event.providerId, event.providerSessionId);
    if (globalSessionId !== undefined && this.#internalSessionIds.has(globalSessionId)) return;
    let payload: JsonObject = event.payload;
    if (event.approval !== undefined && globalSessionId !== undefined) {
      const approval = this.#approvals.add(this.config.hostId, globalSessionId, this.requireAdapter(event.providerId), event.approval);
      payload = { ...event.payload, approval: approval as unknown as JsonObject };
      this.#cache.updateState(globalSessionId, "needs_approval", true);
    }
    if (event.type === "user_input.requested" && globalSessionId !== undefined) {
      const providerRequestId = typeof event.payload.providerRequestId === "string" ? event.payload.providerRequestId : undefined;
      if (providerRequestId === undefined) throw new Error(`${event.providerId} user-input event omitted providerRequestId`);
      const requestSource = event.payload.request;
      const request = typeof requestSource === "object" && requestSource !== null && !Array.isArray(requestSource)
        ? requestSource as JsonObject
        : event.payload;
      const normalized = this.#userInputs.add(
        this.config.hostId,
        globalSessionId,
        this.requireAdapter(event.providerId),
        providerRequestId,
        request,
        typeof event.payload.expiresAt === "string" ? event.payload.expiresAt : undefined,
      );
      payload = { ...event.payload, userInput: normalized as unknown as JsonObject };
      this.#cache.updateState(globalSessionId, "needs_input", false);
    }
    if (globalSessionId !== undefined) {
      if (event.type === "message.started" || event.type === "message.delta" || event.type === "message.completed") {
        this.invalidateMessageSnapshot(globalSessionId);
      }
      if (event.type === "session.status_changed" && isSessionState(event.payload.state)) {
        const state = event.payload.state as RemoteSession["state"];
        this.#cache.updateState(globalSessionId, state, state === "needs_approval");
      } else if (event.type === "session.updated") {
        this.#cache.updateMetadata(globalSessionId, sessionMetadataPatch(event.payload, this.config.hostId, event.providerId));
      } else if (event.type === "message.started" || event.type === "tool.started" || event.type === "command.started") this.#cache.updateState(globalSessionId, "working", false);
      else if (event.type === "agent.completed") this.#cache.updateState(globalSessionId, "completed", false);
      else if (event.type === "agent.error") this.#cache.updateState(globalSessionId, "failed", false);
      else if (event.type === "agent.interrupted") this.#cache.updateState(globalSessionId, "idle", false);
    }
    this.#events.append({
      eventId: `${event.providerId}:${event.eventId}`,
      type: event.type,
      providerId: event.providerId,
      ...(globalSessionId !== undefined ? { sessionId: globalSessionId } : {}),
      occurredAt: event.occurredAt,
      payload,
    });
    if (globalSessionId !== undefined && (
      event.type === "agent.completed" ||
      event.type === "agent.interrupted" ||
      event.type === "agent.error" ||
      (event.type === "session.status_changed" && event.payload.state === "idle")
    )) {
      if (event.type === "agent.completed") await this.maybeAutoCompact(globalSessionId);
      void this.pumpQueue(globalSessionId);
      void this.pumpDelegationsForSession(globalSessionId);
    }
  }

  private reconcileDelegationTimer(): void {
    const hasNonterminalDelegation = [...this.#delegations.values()].some(({ task }) =>
      task.state !== "completed" && task.state !== "failed");
    if (this.#disposed || !hasNonterminalDelegation) {
      if (this.#delegationTimer !== undefined) clearInterval(this.#delegationTimer);
      this.#delegationTimer = undefined;
      return;
    }
    if (this.#delegationTimer !== undefined) return;
    this.#delegationTimer = setInterval(() => {
      this.reconcileDelegationTimer();
      for (const [id, runtime] of this.#delegations) {
        if (runtime.task.state !== "completed" && runtime.task.state !== "failed") void this.pumpDelegation(id);
      }
    }, 1_500);
    this.#delegationTimer.unref();
  }

  private async pumpDelegationsForSession(sessionId: string): Promise<void> {
    for (const [id, runtime] of this.#delegations) {
      if (runtime.task.parentSessionId === sessionId || runtime.task.children.some((child) => child.sessionId === sessionId)) {
        await this.pumpDelegation(id);
      }
    }
  }

  private async pumpDelegation(id: string): Promise<void> {
    const runtime = this.#delegations.get(id);
    if (runtime === undefined || this.#delegationPumps.has(id)) return;
    if (runtime.task.state === "completed" || runtime.task.state === "failed") {
      this.reconcileDelegationTimer();
      return;
    }
    this.#delegationPumps.add(id);
    try {
      const children = runtime.task.children.map((child): DelegationChild => {
        if (child.sessionId === undefined) return child;
        const session = this.#cache.get(child.sessionId);
        if (session === undefined) return child;
        if (session.state === "working") runtime.sawWorking.add(child.sessionId);
        return { ...child, state: session.state };
      });
      const changed = JSON.stringify(children) !== JSON.stringify(runtime.task.children);
      if (changed) {
        runtime.task = { ...runtime.task, children, updatedAt: new Date().toISOString() };
      }

      if (runtime.synthesisDispatched) {
        const parentState = this.#cache.get(runtime.task.parentSessionId)?.state;
        if (parentState === "failed") {
          runtime.task = { ...runtime.task, state: "failed", updatedAt: new Date().toISOString(), error: "Parent synthesis failed" };
          this.appendDelegationEvent("delegation.failed", runtime.task);
        } else if (parentState === "completed" || parentState === "idle") {
          runtime.task = { ...runtime.task, state: "completed", updatedAt: new Date().toISOString() };
          this.appendDelegationEvent("delegation.completed", runtime.task);
        } else if (parentState === "needs_approval" || parentState === "needs_input") {
          runtime.task = { ...runtime.task, state: "needs_attention", updatedAt: new Date().toISOString() };
          this.appendDelegationEvent("delegation.updated", runtime.task);
        } else if (changed) this.appendDelegationEvent("delegation.updated", runtime.task);
        return;
      }

      const attention = children.some((child) => child.state === "needs_approval" || child.state === "needs_input");
      const terminal = children.every((child) => child.state === "failed" || child.state === "completed" || (
        child.sessionId !== undefined && runtime.sawWorking.has(child.sessionId) && child.state === "idle"
      ));
      if (!terminal) {
        const nextState = attention ? "needs_attention" : "working";
        if (runtime.task.state !== nextState || changed) {
          runtime.task = { ...runtime.task, state: nextState, updatedAt: new Date().toISOString() };
          this.appendDelegationEvent("delegation.updated", runtime.task);
        }
        return;
      }

      if (this.hasQueuedParentDelegationTurn(runtime.task)) {
        if (changed) this.appendDelegationEvent("delegation.updated", runtime.task);
        return;
      }
      const parent = this.#cache.get(runtime.task.parentSessionId);
      if (parent === undefined) throw new Error("Parent session is no longer available");
      if (parent.state === "working" || parent.state === "needs_approval" || parent.state === "needs_input" || parent.state === "disconnected" || parent.state === "unknown") {
        if (changed) this.appendDelegationEvent("delegation.updated", runtime.task);
        return;
      }
      const reports = await Promise.all(children.map(async (child) => {
        if (child.sessionId === undefined) return { child, output: child.error ?? "The worker did not start." };
        const { providerSessionId } = parseGlobalSessionId(child.sessionId);
        const messages = await this.requireAdapter(child.providerId).getMessages(providerSessionId);
        return { child, output: latestAssistantOutput(messages) ?? child.error ?? "The worker returned no text output." };
      }));
      runtime.resultsReady = true;
      runtime.synthesisDispatched = true;
      runtime.task = { ...clearDelegationError(runtime.task), state: "synthesizing", updatedAt: new Date().toISOString() };
      this.appendDelegationEvent("delegation.updated", runtime.task);
      this.#cache.updateState(runtime.task.parentSessionId, "working", false);
      await this.sendMessage(runtime.task.parentSessionId, {
        requestId: `delegation_synthesis_${runtime.task.id}`,
        content: delegationSynthesisInstruction(runtime.task, reports, this.#clientTooling !== undefined),
        metadata: { delegationId: runtime.task.id, kind: "delegation_synthesis" },
      });
    } catch (error) {
      runtime.task = {
        ...runtime.task,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.appendDelegationEvent("delegation.failed", runtime.task);
    } finally {
      this.#delegationPumps.delete(id);
      this.reconcileDelegationTimer();
    }
  }

  private appendDelegationEvent(
    type: "delegation.started" | "delegation.updated" | "delegation.completed" | "delegation.failed",
    task: DelegationTask,
  ): void {
    this.#events.append({
      type,
      sessionId: task.parentSessionId,
      payload: task as unknown as JsonObject,
    });
    this.#onDelegationsChange?.(this.delegations());
  }

  private restoreDelegationLinks(): void {
    for (const runtime of this.#delegations.values()) {
      for (const child of runtime.task.children) {
        if (child.sessionId === undefined) continue;
        const session = this.#cache.get(child.sessionId);
        if (session === undefined) continue;
        const displayName = this.#adapters.get(child.providerId)?.displayName ?? child.providerId;
        this.#cache.upsert({
          ...session,
          parentSessionId: runtime.task.parentSessionId,
          agentNickname: session.agentNickname ?? `${displayName} delegate`,
          agentRole: session.agentRole ?? "cross_harness_delegate",
          ...(child.modelId !== undefined ? { modelId: child.modelId } : {}),
          ...(child.reasoningEffort !== undefined ? { reasoningEffort: child.reasoningEffort } : {}),
        });
      }
    }
  }

  private async connectProvider(adapter: AgentProviderAdapter): Promise<void> {
    if (this.#subscribedProviders.has(adapter.providerId)) return;
    try {
      const detection = await adapter.detect();
      if (!detection.available) throw this.providerUnavailableError(adapter, detection);
      const subscription = await adapter.subscribe(null, (event) => this.receiveProviderEvent(event));
      try {
        if (adapter.listQueuedMessages !== undefined) {
          this.syncProviderQueue(adapter.providerId, await adapter.listQueuedMessages());
        }
      } catch (error) {
        await subscription.unsubscribe().catch(() => undefined);
        throw error;
      }
      this.#subscriptions.push(subscription);
      this.#subscribedProviders.add(adapter.providerId);
      this.#providerConnectionErrors.delete(adapter.providerId);
      this.#events.append({ type: "provider.connected", providerId: adapter.providerId, payload: {} });
    } catch (error) {
      const providerError = providerErrorFromUnknown(adapter.providerId, error);
      this.#providerConnectionErrors.set(adapter.providerId, providerError);
      this.#events.append({
        type: "provider.disconnected",
        providerId: adapter.providerId,
        payload: { code: providerError.code, message: providerError.message },
      });
      throw error;
    }
  }

  private providerUnavailableError(adapter: AgentProviderAdapter, detection: ProviderDetection): ProviderAdapterError {
    const message = detection.details.map((detail) => detail.trim()).filter(Boolean).join(" ") || `${adapter.displayName} is not available on this host.`;
    return new ProviderAdapterError(adapter.providerId, "PROVIDER_UNAVAILABLE", message, true);
  }

  private unavailableProviderCapabilities() {
    return {
      authentication: false, listSessions: false, paginatedSessions: false, sessionHistory: false, createSession: false,
      resumeSession: false, sendMessage: false, steering: false, streamingText: false, toolEvents: false, commandEvents: false,
      fileChanges: false, approvals: false, userInput: false, interrupt: false, modelEnumeration: false, projectAssociation: false,
      sessionRelationships: false,
      messageEditing: false,
      remoteConnectivity: "none" as const, notes: ["Capabilities unavailable because provider detection failed."],
    };
  }

  private requireAdapter(providerId: string): AgentProviderAdapter {
    const adapter = this.#adapters.get(providerId);
    if (adapter === undefined) throw new Error(`Provider ${providerId} is not registered`);
    return adapter;
  }

  private assertSessionHost(globalSessionId: string) {
    const parsed = parseGlobalSessionId(globalSessionId);
    if (parsed.hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    return parsed;
  }

  private async maybeAutoCompact(globalSessionId: string): Promise<void> {
    if (!this.#compactionThresholds.has(globalSessionId) || this.#compactingSessions.has(globalSessionId)) return;
    try {
      const context = await this.sessionContext(globalSessionId);
      const threshold = context.compactionThresholdTokens;
      if (!context.supportsThreshold || threshold === null) return;
      if (context.usedTokens === null || context.usedTokens < threshold) {
        this.#lastCompactionUsage.delete(globalSessionId);
        return;
      }
      if (this.#lastCompactionUsage.get(globalSessionId) === context.usedTokens) return;
      await this.compactSession(globalSessionId);
    } catch {
      // Context telemetry and compaction are optional provider features. A
      // failed automatic attempt must never fail an otherwise completed turn.
    }
  }

  private appendQueueEvent(type: "message.queued" | "message.queue_updated", message: QueuedMessage): void {
    this.#events.append({
      type,
      sessionId: message.sessionId,
      payload: message as unknown as JsonObject,
    });
  }

  private syncProviderQueue(providerId: string, source: readonly unknown[]): void {
    const messages = source.filter(isProviderQueuedMessage);
    const views = messages.map((message) => ({ message, view: this.providerQueuedMessage(providerId, message) }));
    const nextIds = new Set(views.map(({ view }) => view.id));
    for (const [messageId, record] of this.#queuedMessages) {
      if (!record.providerOwned) continue;
      const parsed = parseGlobalSessionId(record.view.sessionId);
      if (parsed.providerId !== providerId || nextIds.has(messageId)) continue;
      this.#queuedMessages.delete(messageId);
      this.#events.append({
        type: "message.queue_removed",
        providerId,
        sessionId: record.view.sessionId,
        payload: { messageId, reason: "provider_removed" },
      });
    }
    for (const { message, view } of views) {
      const previous = this.#queuedMessages.get(view.id)?.view;
      this.#queuedMessages.set(view.id, { view, providerOwned: true, providerMessageId: message.id });
      if (previous === undefined) this.appendQueueEvent("message.queued", view);
      else if (JSON.stringify(previous) !== JSON.stringify(view)) this.appendQueueEvent("message.queue_updated", view);
    }
  }

  private providerQueuedMessage(providerId: string, message: ProviderQueuedMessage): QueuedMessage {
    return {
      id: providerQueueMessageId(providerId, message.providerSessionId, message.id),
      sessionId: makeGlobalSessionId(this.config.hostId, providerId, message.providerSessionId),
      content: message.content,
      mode: "queue",
      state: message.state,
      createdAt: message.createdAt,
      attachments: [],
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
  }

  private async pumpQueue(globalSessionId: string): Promise<void> {
    if (this.#queuePumps.has(globalSessionId) || this.#disposed) return;
    const state = this.#cache.get(globalSessionId)?.state;
    if (state === "working" || state === "needs_approval" || state === "needs_input" || state === "disconnected" || state === "unknown") return;
    const next = [...this.#queuedMessages.values()]
      .filter((record) => !record.providerOwned && record.view.sessionId === globalSessionId && record.view.state === "queued")
      .sort((left, right) => left.view.createdAt.localeCompare(right.view.createdAt))[0];
    if (next === undefined) return;
    if (next.request === undefined) return;
    this.#queuePumps.add(globalSessionId);
    next.view = { ...next.view, state: "sending" };
    this.appendQueueEvent("message.queue_updated", next.view);
    try {
      await this.sendMessage(globalSessionId, next.request);
      this.#queuedMessages.delete(next.view.id);
      this.#cache.updateState(globalSessionId, "working", false);
      this.#events.append({
        type: "message.queue_removed",
        sessionId: globalSessionId,
        payload: { messageId: next.view.id, reason: "dispatched" },
      });
    } catch (error) {
      next.view = {
        ...next.view,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      this.appendQueueEvent("message.queue_updated", next.view);
    } finally {
      this.#queuePumps.delete(globalSessionId);
    }
  }

  private requirePrimarySession(sessionId: string): RemoteSession {
    this.assertSessionHost(sessionId);
    if (this.#internalSessionIds.has(sessionId)) throw new Error("Internal helper sessions cannot own visual support");
    const session = this.#cache.get(sessionId);
    if (session === undefined) throw new Error("Session is not loaded on this bridge");
    return session;
  }

  private async validateVisionProxySelection(selection: VisionProxySelection): Promise<void> {
    if (!selection.providerId.trim() || !selection.modelId.trim()) throw new Error("Visual support requires a harness and model");
    const adapter = this.requireAdapter(selection.providerId);
    if (adapter.sessionCreationFeatures?.hiddenDeveloperInstructions !== true) {
      throw new Error(`${selection.providerId} cannot receive hidden session-scoped visual-support instructions`);
    }
    const model = (await this.listModels(selection.providerId)).find((candidate) => candidate.id === selection.modelId);
    if (model === undefined) throw new Error("The selected visual-support model is unavailable");
    if (model.inputModalities?.includes("image") !== true) throw new Error("The selected model does not advertise image input");
  }

  private rememberVisionAttachments(sessionId: string, attachments: readonly MessageAttachment[]): void {
    const runtime = this.#visionProxies.get(sessionId);
    if (runtime === undefined) return;
    runtime.attachments.clear();
    for (const attachment of attachments) runtime.attachments.set(attachment.name, attachment);
  }

  private async routeVisionAttachments(sessionId: string, request: SendMessageRequest): Promise<SendMessageRequest> {
    if ((request.attachments?.length ?? 0) === 0) return request;
    const imageAttachments = request.attachments!.filter((attachment) => attachment.mimeType.toLowerCase().startsWith("image/"));
    const nonImageAttachments = request.attachments!.filter((attachment) => !attachment.mimeType.toLowerCase().startsWith("image/"));
    this.rememberVisionAttachments(sessionId, imageAttachments);
    if (imageAttachments.length === 0) return request;
    const runtime = this.#visionProxies.get(sessionId);
    if (runtime === undefined) return request;
    const session = this.requirePrimarySession(sessionId);
    const supportsImages = await this.primaryModelImageSupport(session, request.modelId);
    if (supportsImages !== false) return request;
    return {
      ...request,
      content: `${request.content}\n\n[An attached image is available through the ask_eyes tool. Use it for any visual details you need.]`,
      attachments: nonImageAttachments,
    };
  }

  private assertAttachmentProvider(providerId: string, attachments: readonly MessageAttachment[] | undefined): void {
    if (providerId === "opencode" || attachments === undefined) return;
    if (attachments.some((attachment) => !attachment.mimeType.toLowerCase().startsWith("image/"))) {
      throw new Error("Generic file attachments are available only for OpenCode");
    }
  }

  private async primaryModelImageSupport(session: RemoteSession, selectedModelId?: string): Promise<boolean | null> {
    const adapter = this.requireAdapter(session.providerId);
    const requestedModelId = selectedModelId ?? session.modelId;
    if (requestedModelId !== undefined && adapter.listModels !== undefined) {
      const selected = (await adapter.listModels().catch(() => [] as readonly RemoteModel[]))
        .find((candidate) => candidate.id === requestedModelId);
      if (selected?.inputModalities !== undefined) return selected.inputModalities.includes("image");
    }
    const metadataSupport = modelImageSupport(session.nativeMetadata);
    if (metadataSupport !== null) return metadataSupport;
    if (adapter.listModels === undefined) return null;
    const models = await adapter.listModels().catch(() => [] as readonly RemoteModel[]);
    const model = (requestedModelId === undefined ? undefined : models.find((candidate) => candidate.id === requestedModelId))
      ?? models.find((candidate) => candidate.isDefault);
    return model?.inputModalities === undefined ? null : model.inputModalities.includes("image");
  }

  private async ensureVisionHelperSession(sessionId: string, runtime: VisionProxyRuntime): Promise<RemoteSession> {
    if (runtime.helperSessionId !== undefined) {
      const cached = this.#cache.get(runtime.helperSessionId);
      if (cached !== undefined) return cached;
    }
    const parent = this.requirePrimarySession(sessionId);
    const adapter = this.requireAdapter(runtime.selection.providerId);
    this.beginInternalSessionCreation(adapter.providerId);
    let created: RemoteSession;
    try {
      created = await adapter.createSession({
        workingDirectory: parent.workingDirectory ?? parent.project ?? process.cwd(),
        title: "Visual support",
        modelId: runtime.selection.modelId,
        ...(runtime.selection.reasoningEffort !== undefined ? { reasoningEffort: runtime.selection.reasoningEffort } : {}),
        developerInstructions: visionProxyDeveloperInstructions,
        ephemeral: adapter.sessionCreationFeatures?.ephemeralSessions === true,
        ...(adapter.sessionCreationFeatures?.selectableClientTools === true ? { clientTools: "none" as const } : {}),
        mcpServers: "none",
        metadata: { internalPurpose: "vision_proxy", parentSessionId: sessionId },
      });
      this.#internalSessionIds.add(created.id);
    } finally {
      await this.finishInternalSessionCreation(adapter.providerId);
    }
    const helper: RemoteSession = {
      ...created,
      parentSessionId: sessionId,
      agentNickname: "Eyes",
      agentRole: "vision_proxy",
      modelId: runtime.selection.modelId,
      ...(runtime.selection.reasoningEffort !== undefined ? { reasoningEffort: runtime.selection.reasoningEffort } : {}),
      nativeMetadata: { ...created.nativeMetadata, internal: true, internalPurpose: "vision_proxy" },
    };
    runtime.helperSessionId = helper.id;
    this.#internalSessionIds.add(helper.id);
    this.#cache.upsert(helper);
    return helper;
  }

  private beginInternalSessionCreation(providerId: string): void {
    const existing = this.#internalSessionCreations.get(providerId);
    if (existing === undefined) this.#internalSessionCreations.set(providerId, { depth: 1, events: [] });
    else existing.depth += 1;
  }

  private async finishInternalSessionCreation(providerId: string): Promise<void> {
    const batch = this.#internalSessionCreations.get(providerId);
    if (batch === undefined) return;
    batch.depth -= 1;
    if (batch.depth > 0) return;
    this.#internalSessionCreations.delete(providerId);
    for (const event of batch.events) await this.receiveProviderEvent(event);
  }

  private async waitForVisionObservation(
    providerId: string,
    providerSessionId: string,
    before: readonly RemoteMessage[],
  ): Promise<string> {
    const adapter = this.requireAdapter(providerId);
    const priorAssistantIds = new Set(before.filter((message) => message.role === "assistant").map((message) => message.id));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const messages = await adapter.getMessages(providerSessionId);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role !== "assistant" || priorAssistantIds.has(message.id) || message.status === "streaming") continue;
        const text = message.parts.flatMap((part) => part.type === "text" ? [part.text.trim()] : []).filter(Boolean).join("\n");
        if (text.length > 0) return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Visual support did not return an observation before the timeout");
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("Agent Bridge has been disposed");
  }
}

function sameVisionSelection(left: VisionProxySelection | undefined, right: VisionProxySelection): boolean {
  return left?.providerId === right.providerId && left.modelId === right.modelId && left.reasoningEffort === right.reasoningEffort;
}

function modelImageSupport(metadata: JsonObject): boolean | null {
  for (const key of ["supportsImageInput", "supportsImages", "imageInput"] as const) {
    if (typeof metadata[key] === "boolean") return metadata[key] as boolean;
  }
  const modalities = metadata.inputModalities ?? metadata.supportedInputModalities ?? metadata.input_modalities;
  if (!Array.isArray(modalities)) return null;
  return modalities.some((value) => value === "image" || (typeof value === "string" && value.startsWith("image/")));
}

function transferWorkingDirectory(source: RemoteSession): string {
  return source.workingDirectory ?? source.project ?? process.cwd();
}

function transferMetadata(relationship: SessionRelationship): JsonObject {
  return {
    relationshipKind: relationship.kind,
    relationshipSourceSessionId: relationship.sourceSessionId,
    relationshipStrategy: relationship.strategy,
  };
}

function copyBranchMessages(messages: readonly RemoteMessage[], branchSessionId: string): readonly RemoteMessage[] {
  return messages.map((message, index) => ({
    ...message,
    id: `${branchSessionId}:copied:${index + 1}`,
    sessionId: branchSessionId,
    providerMessageId: `copied:${message.providerMessageId}:${index + 1}`,
    nativeMetadata: {
      ...message.nativeMetadata,
      branchCopied: true,
      sourceMessageId: message.id,
    },
  }));
}

function transferredSession(
  created: RemoteSession,
  source: RemoteSession,
  relationship: SessionRelationship,
  nativeMetadata: JsonObject = {},
): RemoteSession {
  const session: RemoteSession = {
    ...created,
    ...(source.workingDirectory !== undefined ? { workingDirectory: source.workingDirectory } : {}),
    ...(source.project !== undefined ? { project: source.project } : {}),
    ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
    ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
    relationship,
    nativeMetadata: { ...created.nativeMetadata, ...transferMetadata(relationship), ...nativeMetadata },
  };
  delete (session as { parentSessionId?: string }).parentSessionId;
  return session;
}

function assertFreshTransferSession(source: RemoteSession, created: RemoteSession): void {
  if (created.id === source.id || created.providerSessionId === source.providerSessionId) {
    throw new Error("The provider did not create a fresh session for this context transfer");
  }
  if (created.hostId !== source.hostId || created.providerId !== source.providerId) {
    throw new Error("The provider returned a context-transfer session for a different host or provider");
  }
}

function sessionMetadataPatch(payload: JsonObject, hostId: string, providerId: string): Partial<Pick<RemoteSession, "modelId" | "reasoningEffort" | "variantId" | "parentSessionId" | "agentNickname" | "agentRole">> {
  const modelId = normalizedMetadataValue(payload.modelId);
  const reasoningEffort = normalizedMetadataValue(payload.reasoningEffort);
  const variantId = normalizedMetadataValue(payload.variantId);
  const agentNickname = normalizedMetadataValue(payload.agentNickname);
  const agentRole = normalizedMetadataValue(payload.agentRole);
  let parentSessionId: string | undefined;
  if (typeof payload.parentSessionId === "string") {
    try {
      const parent = parseGlobalSessionId(payload.parentSessionId);
      if (parent.hostId === hostId && parent.providerId === providerId) parentSessionId = payload.parentSessionId;
    } catch {
      // Ignore malformed or cross-provider relation metadata.
    }
  }
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(agentNickname !== undefined ? { agentNickname } : {}),
    ...(agentRole !== undefined ? { agentRole } : {}),
  };
}

function normalizedMetadataValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredMeshString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalMeshInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`timeout_seconds must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function clearDelegationError(task: DelegationTask): DelegationTask {
  const copy = { ...task };
  delete copy.error;
  return copy;
}

function delegatedWorkerInstruction(prompt: string, parent: RemoteSession, displayName: string): string {
  return [
    `You are a ${displayName} worker delegated by another coding-agent session.`,
    "Work independently on the task below in the same project. Return a concise, self-contained result for the parent agent to consume.",
    "Do not wait for, message, or attempt to spawn the parent. If you cannot complete something, state the exact blocker.",
    `Parent task: ${parent.title}`,
    "",
    prompt,
  ].join("\n");
}

function delegationStartedInstruction(task: DelegationTask, sharedToolServer: boolean): string {
  const workers = task.children.map((child, index) =>
    `Worker ${index + 1}: ${child.providerId}${child.modelId === undefined ? "" : ` / ${child.modelId}`}${child.reasoningEffort === undefined ? "" : ` / ${child.reasoningEffort}`} (${child.state})`,
  ).join("\n");
  return [
    `[[UAR_MESH_STARTED:${task.id}]]`,
    "This is structured cross-harness delegation context supplied by the Tethoq bridge.",
    "The delegated workers below are continuing independently in the background. Their sessions remain tracked if you finish this turn, and the bridge will provide their first results in a later turn when they are ready.",
    ...(sharedToolServer ? [
      "You can use the mesh tools to inspect live states, read available output, send follow-ups, or wait when a worker result is actually needed for the response you are composing.",
      `When a mesh tool asks for parent_session_id, use exactly: ${task.parentSessionId}`,
    ] : []),
    "Continue any useful main-session work now. You may respond and finish this turn while workers are still running; do not claim to have read results that have not arrived.",
    "Do not repeat this coordination envelope verbatim in your answer.",
    "",
    "Original user request:",
    task.prompt,
    "",
    "Background workers:",
    workers,
  ].join("\n");
}

function providerQueueMessageId(providerId: string, providerSessionId: string, messageId: string): string {
  return ["provider_queue", providerId, providerSessionId, messageId].map(encodeURIComponent).join("/");
}

function latestAssistantOutput(messages: readonly RemoteMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const output = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (output) return output.slice(0, 24_000);
  }
  return undefined;
}

function delegationSynthesisInstruction(
  task: DelegationTask,
  reports: readonly { readonly child: DelegationChild; readonly output: string }[],
  sharedToolServer: boolean,
): string {
  const workers = reports.map(({ child, output }, index) => [
    `Worker ${index + 1}: ${child.providerId}${child.modelId === undefined ? "" : ` / ${child.modelId}`}${child.reasoningEffort === undefined ? "" : ` / ${child.reasoningEffort}`}`,
    `Status: ${child.state}`,
    output,
  ].join("\n")).join("\n\n---\n\n");
  return [
    `[[UAR_MESH_RESULT:${task.id}]]`,
    "This is structured cross-harness delegation context supplied by the Tethoq bridge.",
    "The bridge has waited for every delegated worker's first response. You have structured mesh tools to list them, read their latest results, send follow-up instructions, and wait again.",
    ...(sharedToolServer ? [`When a mesh tool asks for parent_session_id, use exactly: ${task.parentSessionId}`] : []),
    "Use follow-ups whenever a result is incomplete, unclear, contradictory, or needs verification. Waiting is optional: wait only for a follow-up needed by the response you are composing, and otherwise finish the turn while it continues in the background.",
    "Do not claim a failed worker succeeded, and do not repeat this coordination envelope verbatim in your answer.",
    "",
    "Original user request:",
    task.prompt,
    "",
    "Delegated worker results:",
    workers,
  ].join("\n");
}

function isProviderQueuedMessage(value: unknown): value is ProviderQueuedMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Partial<ProviderQueuedMessage>;
  return typeof message.id === "string" &&
    typeof message.providerSessionId === "string" &&
    typeof message.content === "string" &&
    (message.state === "queued" || message.state === "sending" || message.state === "failed") &&
    typeof message.createdAt === "string";
}
