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
  earsCancelledMessage,
  earsInstruction,
  earsModelKey,
  earsUserPrompt,
  isEarsAudioMimeType,
  isEarsMode,
  lowestReasoningEffort,
  normalizeSimplifySettings,
  parseEarsModelKey,
  parseSimplifyCommand,
  routeAcceptsEarsAudio,
  simplifyDeveloperInstructions,
  type AgentEvent,
  type EventReplaySlice,
  type ApprovalResponse,
  type ConfigureWalletRequest,
  type CrossSessionMessage,
  type CrossSessionMessageEnvelope,
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
  type SignedCredential,
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
  hiddenProviderControlContent,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type CreateSessionOptions,
  type EditMessageRequest,
  type ProviderEvent,
  type ObservedExternalSessionLaunch,
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
import type { SessionSelection } from "./session_selection_store.js";
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
import { maximumCompactionThresholds } from "./compaction_threshold_store.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";
import {
  maxCrossSessionContentLength,
  maxCrossSessionMessages,
  maxPendingCrossSessionMessagesPerTarget,
} from "./cross_session_store.js";
import { sideChatBootstrap, sideChatDeveloperInstructions } from "./side_chat.js";

export interface OpenSessionResult {
  readonly session: RemoteSession;
  readonly messages: readonly RemoteMessage[];
  readonly nextCursor: string | null;
}

interface QueuedMessageRecord {
  view: QueuedMessage;
  request?: SendMessageRequest;
  readonly providerOwned: boolean;
  readonly providerMessageId?: string;
}

export interface SideChatResult {
  readonly session: RemoteSession;
  readonly copiedMessageCount: number;
}

export interface SideChatListItem {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly state: RemoteSession["state"];
  readonly updatedAt: string;
  readonly preview?: string;
}

export interface QueuedTaskSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
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

interface ParentObservedExternalLaunch extends ObservedExternalSessionLaunch {
  readonly parentSessionId: string;
}

const messageSnapshotTtlMs = 2_000;
const maxMessageSnapshots = 32;
const maxPersistedSessionTransfers = 1_000;
const maximumPendingExternalLaunches = 100;
const externalLaunchHistoryWindowMs = 7 * 24 * 60 * 60_000;

function firstUserPromptPreview(messages: readonly RemoteMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts
      .flatMap((part) => part.type === "text" ? [part.text.trim()] : [])
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 240);
  }
  return undefined;
}

function previewRepeatsTitle(session: RemoteSession): boolean {
  const preview = session.preview?.trim();
  return preview === undefined || preview === "" || preview.toLocaleLowerCase() === session.title.trim().toLocaleLowerCase();
}
const externalLaunchMatchWindowMs = 5 * 60_000;
const externalLaunchHistoryScanCooldownMs = 15_000;
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

const resubscribeCooldownMs = 3_000;
const maximumResubscribeCooldownMs = 120_000;

export class AgentBridge {
  readonly #adapters = new Map<string, AgentProviderAdapter>();
  readonly #messageSnapshots = new Map<string, MessageSnapshotRecord>();
  readonly #messageSnapshotGenerations = new Map<string, number>();
  readonly #openSessionLoads = new Map<string, OpenSessionLoad>();
  readonly #cache = new SessionCache({
    preserveWorking: (sessionId) => this.delegatedChildTurnInFlight(sessionId),
    onSelectionsChange: (selections) => this.#onSessionSelectionsChange?.(selections),
  });
  readonly #events: EventReplayBuffer;
  readonly #deduper = new EventDeduper();
  readonly #subscriptions: Subscription[] = [];
  readonly #subscribedProviders = new Set<string>();
  /** Providers that have answered a detection probe at least once this run. */
  readonly #everDetected = new Set<string>();
  readonly #lastGoodCapabilities = new Map<string, ProviderConnection["capabilities"]>();
  readonly #connectPromises = new Map<string, Promise<void>>();
  readonly #resubscribeTimers = new Map<string, NodeJS.Timeout>();
  readonly #resubscribeAttempts = new Map<string, number>();
  readonly #watchedSessionIds = new Set<string>();
  readonly #providerConnectionErrors = new Map<string, ReturnType<typeof providerErrorFromUnknown>>();
  readonly #approvals = new ApprovalRegistry();
  readonly #userInputs = new UserInputRegistry();
  readonly #pairing: PairingManager;
  readonly #deviceRevokedListeners = new Set<(deviceId: string) => void>();
  readonly #deviceVerifier: DeviceActionVerifier;
  readonly #sendLedger = new RequestLedger<SendMessageResult>();
  readonly #pendingContextHandoffs = new Map<string, PendingContextHandoff>();
  readonly #pendingBranchBootstraps = new Map<string, PendingBranchBootstrap>();
  readonly #branchCopies = new Map<string, readonly RemoteMessage[]>();
  readonly #sessionTransfers = new Map<string, SessionTransferRecord>();
  readonly #pendingHandoffSends = new Map<string, Promise<void>>();
  readonly #attachmentUploads: AttachmentUploadManager;
  readonly #transcriptionSources: TranscriptionSourceRegistry;
  readonly #onTranscriptionCredentialChange: ((sourceId: string, apiKey: string | undefined) => void | Promise<void>) | undefined;
  readonly #queuedMessages = new Map<string, QueuedMessageRecord>();
  readonly #queuePumps = new Set<string>();
  readonly #queueMutations = new Set<string>();
  readonly #crossSessionMessages = new Map<string, CrossSessionMessage>();
  readonly #crossSessionPumps = new Set<string>();
  readonly #delegations = new Map<string, DelegationRuntime>();
  readonly #visionProxies = new Map<string, VisionProxyRuntime>();
  readonly #earsHelpers = new Map<string, string>();
  readonly #earsHelperCreations = new Map<string, Promise<RemoteSession>>();
  readonly #earsTranscriptionTails = new Map<string, Promise<void>>();
  readonly #earsJobs = new Map<string, { cancelled: boolean }>();
  readonly #onEarsHelpersChange: ((helpers: Readonly<Record<string, string>>) => void) | undefined;
  readonly #internalHelperWorkingDirectory: string;
  readonly #compactionThresholds = new Map<string, number>();
  readonly #onCompactionThresholdsChange: ((thresholds: Readonly<Record<string, number>>) => void | Promise<void>) | undefined;
  readonly #compactingSessions = new Set<string>();
  readonly #compactionKinds = new Map<string, "automatic" | "manual">();
  readonly #pendingExternalLaunches: ParentObservedExternalLaunch[] = [];
  #lastExternalLaunchHistoryScanAt = 0;
  #externalLaunchHistoryScan: Promise<void> | null = null;
  readonly #lastCompactionUsage = new Map<string, number>();
  readonly #interruptions = new Map<string, Promise<void>>();
  readonly #internalSessionIds = new Set<string>();
  readonly #internalSessionCreations = new Map<string, { depth: number; readonly events: ProviderEvent[] }>();
  readonly #delegationPumps = new Set<string>();
  readonly #onDelegationsChange: ((tasks: readonly DelegationTask[]) => void) | undefined;
  #onSessionSelectionsChange: ((selections: Readonly<Record<string, SessionSelection>>) => void) | undefined;
  readonly #onSessionTransfersChange: ((transfers: readonly SessionTransferRecord[]) => void) | undefined;
  readonly #onCrossSessionMessagesChange: ((messages: readonly CrossSessionMessage[]) => void | Promise<void>) | undefined;
  readonly #globalAgentInstructions: (() => Promise<string | undefined>) | undefined;
  readonly #sessionMaySpawnForeignSubagents: ((sessionId: string) => boolean) | undefined;
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
      readonly onTranscriptionCredentialChange?: (sourceId: string, apiKey: string | undefined) => void | Promise<void>;
      readonly delegations?: readonly DelegationTask[];
      readonly onDelegationsChange?: (tasks: readonly DelegationTask[]) => void;
      readonly sessionTransfers?: readonly SessionTransferRecord[];
      readonly onSessionTransfersChange?: (transfers: readonly SessionTransferRecord[]) => void;
      readonly crossSessionMessages?: readonly CrossSessionMessage[];
      readonly onCrossSessionMessagesChange?: (messages: readonly CrossSessionMessage[]) => void | Promise<void>;
      readonly globalAgentInstructions?: () => Promise<string | undefined>;
      readonly sessionMaySpawnForeignSubagents?: (sessionId: string) => boolean;
      readonly sessionSelections?: Readonly<Record<string, SessionSelection>>;
      readonly onSessionSelectionsChange?: (selections: Readonly<Record<string, SessionSelection>>) => void;
      readonly earsHelpers?: Readonly<Record<string, string>>;
      readonly onEarsHelpersChange?: (helpers: Readonly<Record<string, string>>) => void;
      readonly internalHelperWorkingDirectory?: string;
      readonly compactionThresholds?: Readonly<Record<string, number>>;
      readonly onCompactionThresholdsChange?: (thresholds: Readonly<Record<string, number>>) => void | Promise<void>;
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
    this.#onTranscriptionCredentialChange = pairingOptions.onTranscriptionCredentialChange;
    this.#onDelegationsChange = pairingOptions.onDelegationsChange;
    this.#onSessionTransfersChange = pairingOptions.onSessionTransfersChange;
    this.#onCrossSessionMessagesChange = pairingOptions.onCrossSessionMessagesChange;
    this.#globalAgentInstructions = pairingOptions.globalAgentInstructions;
    this.#sessionMaySpawnForeignSubagents = pairingOptions.sessionMaySpawnForeignSubagents;
    this.#onSessionSelectionsChange = pairingOptions.onSessionSelectionsChange;
    this.#onEarsHelpersChange = pairingOptions.onEarsHelpersChange;
    this.#internalHelperWorkingDirectory = pairingOptions.internalHelperWorkingDirectory ?? process.cwd();
    this.#onCompactionThresholdsChange = pairingOptions.onCompactionThresholdsChange;
    for (const [sessionId, threshold] of Object.entries(pairingOptions.compactionThresholds ?? {})) {
      try {
        const parsed = parseGlobalSessionId(sessionId);
        if (parsed.hostId !== this.config.hostId || !Number.isSafeInteger(threshold) || threshold <= 0) continue;
        this.rememberCompactionThreshold(sessionId, threshold);
      } catch {
        // Malformed local settings are ignored instead of being attached to another task.
      }
    }
    this.#cache.restoreSelections(pairingOptions.sessionSelections ?? {});
    for (const [key, helperId] of Object.entries(pairingOptions.earsHelpers ?? {})) {
      try {
        const model = parseEarsModelKey(key);
        const helper = parseGlobalSessionId(helperId);
        if (model === undefined || model.providerId !== helper.providerId || helper.hostId !== this.config.hostId) continue;
        this.#earsHelpers.set(key, helperId);
        this.#internalSessionIds.add(helperId);
      } catch {
        // A malformed local helper record is ignored rather than hiding an unrelated task.
      }
    }
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
    for (const message of pairingOptions.crossSessionMessages ?? []) {
      this.#crossSessionMessages.set(message.envelope.id, message);
    }
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

  /**
   * Swaps a registered provider for a fresh adapter to the same provider id -
   * used when the desktop repoints at a different OpenCode server. The new
   * adapter is registered even when its connection attempt fails so the
   * resubscribe loop retries against the new server.
   */
  public async replaceProviderAdapter(adapter: AgentProviderAdapter): Promise<void> {
    this.assertActive();
    const existing = this.#adapters.get(adapter.providerId);
    if (existing === undefined) throw new Error(`Provider ${adapter.providerId} is not registered`);
    if (existing === adapter) return;
    await existing.dispose();
    this.#subscribedProviders.delete(adapter.providerId);
    this.#adapters.set(adapter.providerId, adapter);
    if (this.#clientTooling !== undefined) adapter.configureClientTooling?.(this.#clientTooling);
    this.#refresh = new RefreshCoordinator(this.#adapters, this.#cache);
    await this.connectProvider(adapter);
    await this.#refresh.refreshProvider(adapter.providerId);
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

  /** Re-lists one provider without touching the others. */
  public async refreshProvider(providerId: string): Promise<void> {
    this.assertActive();
    await this.#refresh.refreshProvider(providerId);
    this.restoreSessionTransferLinks();
    this.linkObservedExternalSessions(this.#pendingExternalLaunches);
    await this.maybeDiscoverHistoricalExternalSessionLinks();
  }

  /**
   * Whether the provider's live event subscription is up. This governs streaming,
   * not the ability to send: a detected provider answers requests either way.
   */
  public isProviderConnected(providerId: string): boolean {
    return this.#subscribedProviders.has(providerId);
  }

  public async reconnectProvider(providerId: string): Promise<void> {
    const adapter = this.requireAdapter(providerId);
    await this.connectProvider(adapter);
    // Subscribing starts the live feed and nothing more. Sessions that already
    // existed on the provider are only ever learned by listing, so a provider
    // that comes up after the startup refresh has to be re-listed here or its
    // history stays missing from the cache.
    await this.#refresh.refreshProvider(providerId);
  }

  /** Provider-native session ids that currently have a model turn in flight. */
  public providerActiveSessions(providerId: string): readonly string[] {
    return this.#adapters.get(providerId)?.activeSessionIds?.() ?? [];
  }

  /** True while any session still streams through the provider's secondary feed. */
  public isProviderSecondaryBusy(providerId: string): boolean {
    return this.#adapters.get(providerId)?.isSecondaryBusy?.() === true;
  }

  /** Attaches or detaches the provider's secondary server feed. */
  public setProviderSecondaryUrl(providerId: string, url: string | undefined): void {
    this.#adapters.get(providerId)?.setSecondaryBaseUrl?.(url);
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
    return await this.withIdleRelease(adapter, () => adapter.listModels!());
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
    if (threshold !== null && threshold !== storedThreshold) {
      this.rememberCompactionThreshold(globalSessionId, threshold);
      await this.persistCompactionThresholds();
    }
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
      compactionKind: this.#compactionKinds.get(globalSessionId) ?? null,
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
    const previousThresholds = new Map(this.#compactionThresholds);
    const previousCompactionUsage = this.#lastCompactionUsage.get(globalSessionId);
    this.rememberCompactionThreshold(globalSessionId, thresholdTokens);
    this.#lastCompactionUsage.delete(globalSessionId);
    try {
      if (context.usedTokens !== null && thresholdTokens <= context.usedTokens) await this.compactSession(globalSessionId, "manual");
      await this.persistCompactionThresholds();
    } catch (error) {
      this.#compactionThresholds.clear();
      for (const [sessionId, threshold] of previousThresholds) this.#compactionThresholds.set(sessionId, threshold);
      if (previousCompactionUsage === undefined) this.#lastCompactionUsage.delete(globalSessionId);
      else this.#lastCompactionUsage.set(globalSessionId, previousCompactionUsage);
      throw error;
    }
    return await this.sessionContext(globalSessionId);
  }

  public async compactSession(globalSessionId: string, kind: "automatic" | "manual" = "manual"): Promise<void> {
    this.assertActive();
    if (this.#compactingSessions.has(globalSessionId)) return;
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const adapter = this.requireAdapter(providerId);
    if (adapter.compactSession === undefined) throw new Error(`${adapter.displayName} does not expose context compaction`);
    this.#compactingSessions.add(globalSessionId);
    this.#compactionKinds.set(globalSessionId, kind);
    this.#events.append({
      type: "context.compaction_started",
      providerId,
      sessionId: globalSessionId,
      payload: { kind },
    });
    let completed = false;
    try {
      const before = await this.sessionContext(globalSessionId).catch(() => undefined);
      if (before?.usedTokens !== null && before?.usedTokens !== undefined) this.#lastCompactionUsage.set(globalSessionId, before.usedTokens);
      await adapter.compactSession(providerSessionId);
      completed = true;
    } finally {
      this.#compactingSessions.delete(globalSessionId);
      this.#compactionKinds.delete(globalSessionId);
    }
    if (completed) {
      this.#events.append({
        type: "context.compaction_completed",
        providerId,
        sessionId: globalSessionId,
        payload: { kind },
      });
    }
  }

  public async providerConnections(): Promise<readonly ProviderConnection[]> {
    return await Promise.all([...this.#adapters.values()].map(async (adapter): Promise<ProviderConnection> => {
      return await this.withIdleRelease(adapter, async () => {
        try {
          let detection = await adapter.detect();
          // Detection is a single unretried probe, and a provider that reads
          // unavailable loses every capability - which is what takes the send
          // control away from the user. A provider that has answered before has
          // earned a second ask, so one dropped probe cannot do that. Providers
          // that never answered are not re-probed, so a genuinely missing tool
          // costs the same as before.
          if (!detection.available && this.#everDetected.has(adapter.providerId)) {
            detection = await adapter.detect();
          }
          if (detection.available) this.#everDetected.add(adapter.providerId);
          if (!detection.available) {
            return this.unreachableProvider(adapter, this.providerUnavailableError(adapter, detection));
          }
          const [auth, capabilities] = await Promise.all([adapter.getAuthStatus(), adapter.getCapabilities()]);
          this.#lastGoodCapabilities.set(adapter.providerId, capabilities);
          const connected = this.#subscribedProviders.has(adapter.providerId);
          if (!connected) this.scheduleProviderResubscribe(adapter.providerId);
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
          return this.unreachableProvider(adapter, error);
        }
      });
    }));
  }

  public async refresh(): Promise<RefreshResult> {
    this.assertActive();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => this.connectProvider(adapter)));
    const result = await this.#refresh.refresh();
    this.restoreDelegationLinks();
    await this.restorePersistedSubagentSessions();
    this.restoreSessionTransferLinks();
    this.linkObservedExternalSessions(this.#pendingExternalLaunches);
    await this.maybeDiscoverHistoricalExternalSessionLinks();
    this.reconcileDelegationTimer();
    await this.reconcileCrossSessionDeliveries();
    for (const targetSessionId of new Set([...this.#crossSessionMessages.values()]
      .filter((message) => message.state === "pending")
      .map((message) => message.envelope.targetSessionId))) {
      void this.pumpCrossSessionInbox(targetSessionId);
    }
    await Promise.all([...this.#adapters.values()].map((adapter) => this.releaseProviderIfIdle(adapter)));
    return { ...result, sessions: this.sessions() };
  }

  public sessions(): readonly RemoteSession[] {
    return this.#cache.all().filter((session) => !this.#internalSessionIds.has(session.id));
  }

  public async visionProxyTargets(): Promise<readonly VisionProxyTarget[]> {
    this.assertActive();
    const targets = await Promise.all([...this.#adapters.values()].map(async (adapter): Promise<VisionProxyTarget | null> => {
      return await this.withIdleRelease(adapter, async () => {
        try {
          if (adapter.listModels === undefined) return null;
          const capabilities = await adapter.getCapabilities();
          if (!capabilities.createSession || !capabilities.sendMessage || !capabilities.modelEnumeration) return null;
          const models = (await adapter.listModels()).filter((model) => model.inputModalities?.includes("image") === true);
          return models.length === 0 ? null : { providerId: adapter.providerId, displayName: adapter.displayName, models };
        } catch {
          return null;
        }
      });
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
      developerInstructions: visionProxyDeveloperInstructions,
      attachments: images,
      metadata: { internalPurpose: "vision_proxy", parentSessionId: sessionId },
    });
    const observation = await this.waitForVisionObservation(runtime.selection.providerId, helper.providerSessionId, before);
    return { observation, helperSessionId: helper.id };
  }

  /**
   * One-shot audio-to-text for dictation clips. Creates a hidden helper session
   * and never records a user-visible destination turn.
   */
  public cancelEars(requestId: string): { readonly cancelled: boolean } {
    const job = this.#earsJobs.get(requestId);
    if (job === undefined) return { cancelled: false };
    job.cancelled = true;
    return { cancelled: true };
  }

  public async processEars(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly mode: string;
    readonly attachmentIds: readonly string[];
    readonly sessionId?: string;
    readonly requestId?: string;
  }): Promise<{ readonly texts: readonly string[] }> {
    this.assertActive();
    const mode = input.mode;
    if (!isEarsMode(mode)) throw new Error("EARS mode must be verbatim or cleaned");
    if (input.attachmentIds.length === 0) throw new Error("EARS needs at least one dictation recording");
    const jobId = input.requestId ?? `ears_${randomUUID()}`;
    if (this.#earsJobs.has(jobId)) throw new Error("That EARS transcription request is already running");
    const job = { cancelled: false };
    this.#earsJobs.set(jobId, job);
    try {
      const adapter = this.requireAdapter(input.providerId);
      if (adapter.listModels === undefined) throw new Error("The configured EARS model is no longer available for audio. Choose another model.");
      const models = await adapter.listModels();
      const model = models.find((candidate) => candidate.id === input.modelId);
      if (model === undefined || !routeAcceptsEarsAudio({
        providerId: input.providerId,
        ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
      })) {
        throw new Error("The configured EARS model is no longer available for audio. Choose another model.");
      }
      const reasoningEffort = lowestReasoningEffort(earsEffortsFromModel(model));
      const consumption = this.#attachmentUploads.consume(input.attachmentIds);
      try {
        for (const attachment of consumption.attachments) {
          if (!isEarsAudioMimeType(attachment.mimeType)) throw new Error("EARS only accepts dictation audio recordings");
        }
        this.assertAttachmentProvider(input.providerId, consumption.attachments);
        const cancelled = () => this.#earsJobs.get(jobId)?.cancelled === true;
        if (cancelled()) throw new Error(earsCancelledMessage);
        const helperInput = {
          providerId: input.providerId,
          modelId: input.modelId,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        };
        const texts = await this.withEarsTranscriptionLock(earsModelKey(input.providerId, input.modelId), async () => {
          if (cancelled()) throw new Error(earsCancelledMessage);
          let helper = await this.ensureEarsHelperSession(helperInput);
          let recreatedMissingHelper = false;
          const results: string[] = [];
          for (const [index, attachment] of consumption.attachments.entries()) {
            if (cancelled()) throw new Error(earsCancelledMessage);
            for (;;) {
              try {
                const before = await adapter.getMessages(helper.providerSessionId);
                await adapter.sendMessage(helper.providerSessionId, {
                  requestId: `ears_${randomUUID()}`,
                  content: earsUserPrompt(index + 1),
                  developerInstructions: earsInstruction(mode),
                  modelId: input.modelId,
                  ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
                  attachments: [attachment],
                  metadata: { internalPurpose: "ears" },
                });
                results.push(await this.waitForVisionObservation(input.providerId, helper.providerSessionId, before, "EARS", cancelled));
                break;
              } catch (error) {
                if (recreatedMissingHelper || !isMissingProviderSessionError(error)) throw error;
                recreatedMissingHelper = true;
                helper = await this.ensureEarsHelperSession(helperInput, helper.id);
              }
            }
          }
          return results;
        });
        if (this.#earsJobs.get(jobId)?.cancelled === true) throw new Error(earsCancelledMessage);
        consumption.commit();
        return { texts };
      } catch (error) {
        consumption.release();
        throw error;
      }
    } finally {
      if (this.#earsJobs.get(jobId) === job) this.#earsJobs.delete(jobId);
    }
  }

  public async openSession(globalSessionId: string, cursor?: string, limit = 40, refresh = false): Promise<OpenSessionResult> {
    this.assertActive();
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(globalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    return await this.withIdleRelease(adapter, async () => {
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
      if (!refresh && cached !== undefined && snapshot !== undefined && snapshot.generation === generation && snapshot.freshUntil > Date.now()) {
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
    });
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
    let resolvedSession = this.#cache.get(globalSessionId) ?? session;
    const providerVisible = clientVisibleBranchMessages(clientVisibleHandoffMessages(providerMessages));
    const firstPrompt = firstUserPromptPreview(providerVisible);
    if (firstPrompt !== undefined && previewRepeatsTitle(resolvedSession)) {
      const hydrated = {
        ...resolvedSession,
        preview: firstPrompt,
        nativeMetadata: { ...resolvedSession.nativeMetadata, tethoqClientPreview: firstPrompt },
      };
      this.#cache.upsert(hydrated);
      resolvedSession = this.#cache.get(globalSessionId) ?? hydrated;
    }
    const copied = (resolvedSession.relationship?.kind === "branch" || resolvedSession.relationship?.kind === "side_chat") && resolvedSession.relationship.strategy === "transcript_bootstrap"
      ? this.#branchCopies.get(globalSessionId)
      : undefined;
    const messages = copied === undefined
      ? providerVisible
      : [...copyBranchMessages(copied, globalSessionId), ...providerVisible];
    const decoratedMessages = this.decorateCrossSessionMessages(globalSessionId, messages);
    this.cacheMessageSnapshot(globalSessionId, decoratedMessages, generation);
    return { session: resolvedSession, messages: decoratedMessages };
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
    // OpenCode's normal listing cannot enumerate sessions stored under its
    // catch-all `global` project, even though direct reads by session ID still
    // work. A persisted positive sub-agent relationship gives us the exact IDs
    // to recover without guessing from titles, paths, or timestamps. Missing or
    // deleted provider sessions simply stay absent.
    await this.restorePersistedSubagentSessions(parentGlobalSessionId);
    const delegatedChildren = [...this.#delegations.values()]
      .filter((runtime) => runtime.task.parentSessionId === parentGlobalSessionId)
      .flatMap((runtime) => runtime.task.children)
      .map((child) => child.sessionId === undefined ? undefined : this.#cache.get(child.sessionId))
      .filter((session): session is RemoteSession => session !== undefined);
    const visionHelperId = this.#visionProxies.get(parentGlobalSessionId)?.helperSessionId;
    const visionHelpers = visionHelperId === undefined
      ? []
      : [this.#cache.get(visionHelperId)].filter((session): session is RemoteSession => session !== undefined);
    const observedBeforeRefresh = this.#cache.all().filter((session) =>
      session.relationship?.kind === "subagent" && session.relationship.sourceSessionId === parentGlobalSessionId);
    if (!capabilities.sessionRelationships && delegatedChildren.length === 0 && visionHelpers.length === 0 && observedBeforeRefresh.length === 0) {
      throw new Error(`${providerId} does not support child-session relationships`);
    }
    // Cross-provider children are not covered by the parent's native child query.
    // Re-list only their known providers when the user opens/keeps open the child
    // view so working/completed state is current without refreshing the whole app.
    const observedProviderIds = new Set(observedBeforeRefresh.map((session) => session.providerId).filter((childProviderId) => childProviderId !== providerId));
    await Promise.all([...observedProviderIds].map(async (childProviderId) => { await this.#refresh.refreshProvider(childProviderId); }));
    const observedChildren = this.#cache.all().filter((session) =>
      session.relationship?.kind === "subagent" && session.relationship.sourceSessionId === parentGlobalSessionId);
    const nativeChildren = capabilities.sessionRelationships
      ? (await collectAllSessionPages(adapter, { parentProviderSessionId: providerSessionId, limit: 100 })).sessions
          .filter((session) => session.parentSessionId === parentGlobalSessionId)
      : [];
    const children = [...new Map([...nativeChildren, ...delegatedChildren, ...visionHelpers, ...observedChildren].map((session) => [session.id, session])).values()];
    this.#cache.reconcileChildren(parentGlobalSessionId, children);
    return children.map((session) => this.#cache.get(session.id) ?? session);
  }

  private async restorePersistedSubagentSessions(parentSessionId?: string): Promise<void> {
    const missing = [...this.#sessionTransfers.values()].filter((record) =>
      record.relationship.kind === "subagent"
      && (parentSessionId === undefined || record.relationship.sourceSessionId === parentSessionId)
      && this.#cache.get(record.sessionId) === undefined);
    if (missing.length === 0) return;
    await Promise.all(missing.map(async (record) => {
      try {
        const child = parseGlobalSessionId(record.sessionId);
        const source = parseGlobalSessionId(record.relationship.sourceSessionId);
        if (child.hostId !== this.config.hostId || source.hostId !== this.config.hostId) return;
        const childAdapter = this.#adapters.get(child.providerId);
        if (childAdapter === undefined) return;
        const session = await childAdapter.getSession(child.providerSessionId);
        if (session.id !== record.sessionId) return;
        this.#cache.upsert(session);
      } catch {
        // Persisted provenance is not proof that the provider session still
        // exists. Do not fabricate a placeholder for a deleted session.
      }
    }));
    this.restoreSessionTransferLinks();
  }

  private rememberExternalLaunches(parentSessionId: string, launches: readonly ObservedExternalSessionLaunch[]): void {
    for (const launch of launches) {
      if (launch.targetProviderId === parseGlobalSessionId(parentSessionId).providerId) continue;
      const duplicate = this.#pendingExternalLaunches.some((entry) => entry.parentSessionId === parentSessionId
        && externalLaunchSignature(entry) === externalLaunchSignature(launch));
      if (!duplicate) this.#pendingExternalLaunches.push({ ...launch, parentSessionId });
    }
    while (this.#pendingExternalLaunches.length > maximumPendingExternalLaunches) this.#pendingExternalLaunches.shift();
  }

  private linkObservedExternalSessions(launches: readonly ParentObservedExternalLaunch[]): number {
    let linked = 0;
    const candidates = this.#cache.all().filter((session) =>
      session.parentSessionId === undefined && session.relationship === undefined && session.createdAt !== undefined);
    for (const session of candidates) {
      const matchingLaunches = launches.filter((launch) => externalLaunchMatchesSession(launch, session));
      const matchingParents = new Set(matchingLaunches
        .map((launch) => launch.parentSessionId));
      if (matchingParents.size !== 1) continue;
      const launcherSessionId = [...matchingParents][0]!;
      if (this.#cache.get(launcherSessionId) === undefined) continue;
      const parentSessionId = this.externalLaunchGroupParent(launcherSessionId);
      const matchingSessions = candidates.filter((candidate) => matchingLaunches
        .some((launch) => externalLaunchMatchesSession(launch, candidate)));
      if (matchingSessions.length !== 1) continue;
      const relationship: SessionRelationship = { kind: "subagent", sourceSessionId: parentSessionId, strategy: "native" };
      this.#cache.upsert({
        ...session,
        parentSessionId,
        relationship,
        agentRole: session.agentRole ?? "external_subagent",
        nativeMetadata: {
          ...session.nativeMetadata,
          ...transferMetadata(relationship),
          tethoqObservedExternalLaunch: true,
          tethoqObservedExternalLauncherSessionId: launcherSessionId,
        },
      });
      if (!this.#sessionTransfers.has(session.id)) this.rememberSessionTransfer({ sessionId: session.id, relationship, pending: false });
      linked += 1;
    }
    return linked;
  }

  /** Put externally launched grandchildren on the nearest rail-visible owner. */
  private externalLaunchGroupParent(launcherSessionId: string): string {
    let currentId = launcherSessionId;
    const visited = new Set<string>();
    while (!visited.has(currentId)) {
      visited.add(currentId);
      const current = this.#cache.get(currentId);
      const sourceSessionId = current?.relationship?.kind === "subagent"
        ? current.relationship.sourceSessionId
        : undefined;
      if (sourceSessionId === undefined || this.#cache.get(sourceSessionId) === undefined) break;
      currentId = sourceSessionId;
    }
    return currentId;
  }

  private async maybeDiscoverHistoricalExternalSessionLinks(): Promise<void> {
    if (this.#externalLaunchHistoryScan !== null) return await this.#externalLaunchHistoryScan;
    const now = Date.now();
    if (now - this.#lastExternalLaunchHistoryScanAt < externalLaunchHistoryScanCooldownMs) return;
    this.#lastExternalLaunchHistoryScanAt = now;
    const scan = this.discoverHistoricalExternalSessionLinks();
    this.#externalLaunchHistoryScan = scan;
    try {
      await scan;
    } finally {
      if (this.#externalLaunchHistoryScan === scan) this.#externalLaunchHistoryScan = null;
    }
  }

  private async discoverHistoricalExternalSessionLinks(): Promise<void> {
    const now = Date.now();
    const candidates = this.#cache.all().filter((session) => session.createdAt !== undefined
      && session.parentSessionId === undefined && session.relationship === undefined
      && now - Date.parse(session.createdAt) <= externalLaunchHistoryWindowMs);
    const oldest = candidates.length > 0
      ? Math.min(...candidates.map((session) => Date.parse(session.createdAt!)))
      : now - externalLaunchHistoryWindowMs;
    const newest = candidates.length > 0
      ? Math.max(...candidates.map((session) => Date.parse(session.createdAt!)))
      : now;
    const since = new Date(Math.max(now - externalLaunchHistoryWindowMs, oldest - externalLaunchMatchWindowMs)).toISOString();
    const candidateDirectories = new Set(candidates.map((session) => normalizedLaunchPath(session.workingDirectory)).filter(Boolean));
    const knownParentIds = new Set([...this.#sessionTransfers.values()]
      .filter((record) => record.relationship.kind === "subagent")
      .map((record) => record.relationship.sourceSessionId));
    const parents = this.#cache.all().filter((session) => {
      const adapter = this.#adapters.get(session.providerId);
      if (adapter?.getExternalSessionLaunches === undefined) return false;
      const created = session.createdAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(session.createdAt);
      const updated = Date.parse(session.lastActivityAt);
      return created <= newest + externalLaunchMatchWindowMs && updated >= oldest - externalLaunchMatchWindowMs;
    }).sort((left, right) => {
      const leftKnown = knownParentIds.has(left.id);
      const rightKnown = knownParentIds.has(right.id);
      const leftMatch = candidateDirectories.has(normalizedLaunchPath(left.workingDirectory));
      const rightMatch = candidateDirectories.has(normalizedLaunchPath(right.workingDirectory));
      return Number(rightKnown) - Number(leftKnown)
        || Number(rightMatch) - Number(leftMatch)
        || right.lastActivityAt.localeCompare(left.lastActivityAt);
    }).slice(0, 12);
    if (parents.length === 0) return;
    const discovered = (await Promise.all(parents.map(async (parent) => {
      const adapter = this.#adapters.get(parent.providerId);
      if (adapter?.getExternalSessionLaunches === undefined) return [];
      try {
        const launches = await adapter.getExternalSessionLaunches(parent.providerSessionId, since);
        return launches.map((launch): ParentObservedExternalLaunch => ({ ...launch, parentSessionId: parent.id }));
      } catch {
        return [];
      }
    }))).flat();
    for (const launch of discovered) this.rememberExternalLaunches(launch.parentSessionId, [launch]);
    if (discovered.length === 0) return;

    // OpenCode's ordinary listing can omit its catch-all project entirely. An
    // explicit launch directory is enough to ask that provider for the exact
    // workspace, but not enough to hide anything: only sessions that still pass
    // the title, time, directory, model, unique-child and unique-parent checks
    // below are added and linked.
    const directories = new Map<string, { providerId: string; directory: string; launches: ParentObservedExternalLaunch[] }>();
    for (const launch of discovered) {
      if (launch.workingDirectory === undefined) continue;
      const key = `${launch.targetProviderId}\u0000${normalizedLaunchPath(launch.workingDirectory)}`;
      const group = directories.get(key) ?? { providerId: launch.targetProviderId, directory: launch.workingDirectory, launches: [] };
      group.launches.push(launch);
      directories.set(key, group);
    }
    await Promise.all([...directories.values()].map(async ({ providerId, directory, launches }) => {
      const adapter = this.#adapters.get(providerId);
      if (adapter === undefined) return;
      try {
        const listed = await collectAllSessionPages(adapter, { workingDirectory: directory, limit: 100 });
        for (const session of listed.sessions) {
          if (launches.some((launch) => externalLaunchMatchesSession(launch, session))) this.#cache.upsert(session);
        }
      } catch {
        // Historical grouping is optional. A provider that cannot list this
        // directory must leave its sessions visible/ungrouped rather than fail
        // the whole task catalogue.
      }
    }));
    this.linkObservedExternalSessions(this.#pendingExternalLaunches);
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
      if (target.modelId !== undefined) {
        if (adapter.listModels === undefined) throw new Error(`${target.providerId} cannot validate the selected delegated model`);
        const selectedModel = (await adapter.listModels()).find((model) => model.id === target.modelId);
        if (selectedModel === undefined) throw new Error(`The selected ${target.providerId} delegated model is unavailable`);
        const supportedEfforts = earsEffortsFromModel(selectedModel);
        if (target.reasoningEffort !== undefined && supportedEfforts.length > 0 && !supportedEfforts.includes(target.reasoningEffort)) {
          throw new Error(`${target.reasoningEffort} is not an advertised reasoning level for ${target.modelId}`);
        }
      } else if (target.reasoningEffort !== undefined) {
        throw new Error("A delegated reasoning level requires an explicit model");
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
        const workerInstruction = trimmedPrompt || hiddenProviderControlContent(`mesh-worker:${id}:${index + 1}`);
        const created = await this.createSession(target.providerId, {
          workingDirectory: parent.workingDirectory ?? parent.project ?? process.cwd(),
          title: trimmedPrompt ? `Delegated: ${trimmedPrompt.slice(0, 72)}` : "Delegated worker",
          ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
          ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
          firstInstruction: workerInstruction,
          firstInstructionDeveloperInstructions: delegatedWorkerInstruction(parent, adapter.displayName),
          metadata: { delegationId: id, parentSessionId, role: "cross_harness_delegate" },
        });
        const linked: RemoteSession = {
          ...created,
          state: "working",
          preview: trimmedPrompt || "Awaiting instruction from the parent task",
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
    if (tool === "mesh_list_sessions") {
      const query = optionalMeshString(input, "query", 200) ?? "";
      const limit = optionalMeshInteger(input.limit, 20, 1, 25);
      return { sessions: this.crossSessionTargets(parentSessionId, query, limit).map((session) => ({
        sessionId: session.id,
        title: session.title.slice(0, 240),
        providerId: session.providerId,
        state: session.state,
        project: session.project?.slice(0, 240) ?? null,
        workingDirectory: session.workingDirectory?.slice(0, 2_000) ?? null,
        lastActivityAt: session.lastActivityAt,
      })) };
    }
    if (tool === "mesh_message_session") {
      const targetSessionId = requiredMeshString(input, "target_session_id", 16_384);
      const message = requiredMeshString(input, "message", maxCrossSessionContentLength);
      const requestId = requiredMeshString(input, "request_id", 256);
      return { message: await this.sendCrossSessionMessage(parentSessionId, targetSessionId, requestId, message) as unknown as JsonObject };
    }
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
      content: hiddenProviderControlContent(`mesh-started:${task.id}`),
      developerInstructions: delegationStartedInstruction(task, this.#clientTooling !== undefined),
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
    return [...this.#queuedMessages.values()].some(({ request, view }) =>
      view.sessionId === task.parentSessionId
      && view.state !== "failed"
      && request?.metadata?.delegationId === task.id
      && request.metadata.kind === "delegation_started");
  }

  public async createSession(providerId: string, options: CreateSessionOptions): Promise<RemoteSession> {
    this.assertActive();
    const adapter = this.requireAdapter(providerId);
    return await this.withIdleRelease(adapter, async () => {
      const globalInstructions = await this.#globalAgentInstructions?.();
      const separatedFirstTurn = options.firstInstruction !== undefined
        && (options.firstInstructionDeveloperInstructions !== undefined || globalInstructions !== undefined);
      const {
        firstInstructionDeveloperInstructions: _firstTurnGuidance,
        firstInstruction,
        ...providerOptions
      } = options;
      const providerSession = await adapter.createSession({
        ...providerOptions,
        ...(!separatedFirstTurn && firstInstruction !== undefined ? { firstInstruction } : {}),
        ...(separatedFirstTurn && providerOptions.title === undefined
          ? { title: options.firstInstruction!.split(/\r?\n/u)[0]?.trim().slice(0, 96) || "New task" }
          : {}),
        workingDirectory: options.workingDirectory.trim() || process.cwd(),
      });
      const clientTitle = options.title?.trim() || options.firstInstruction?.split(/\r?\n/u)[0]?.trim().slice(0, 96);
      const clientPreview = options.firstInstruction?.trim().slice(0, 240);
      const session: RemoteSession = {
        ...providerSession,
        ...(clientTitle ? { title: clientTitle } : {}),
        ...(clientPreview ? { preview: clientPreview, state: "working" as const, lastActivityAt: new Date().toISOString() } : {}),
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        nativeMetadata: {
          ...providerSession.nativeMetadata,
          ...(clientTitle ? { tethoqClientTitle: clientTitle, tethoqInitialProviderTitle: providerSession.title } : {}),
          ...(clientPreview ? { tethoqClientPreview: clientPreview } : {}),
        },
      };
      this.#cache.upsert(session);
      if (separatedFirstTurn) {
        const result = await this.sendMessage(session.id, {
          requestId: `first_turn_${randomUUID()}`,
          content: options.firstInstruction!,
          ...(options.firstInstructionDeveloperInstructions !== undefined
            ? { developerInstructions: options.firstInstructionDeveloperInstructions }
            : {}),
          ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        });
        if (!result.accepted) throw new Error(result.details.join(" ") || "The harness did not accept the first instruction");
        const active = { ...session, state: "working" as const, preview: options.firstInstruction!.slice(0, 240), lastActivityAt: new Date().toISOString() };
        this.#cache.upsert(active);
        return active;
      }
      return session;
    });
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
    if (record.relationship.kind === "branch" || record.relationship.kind === "side_chat") {
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
      ...(record.sideChatPreview !== undefined ? { sideChatPreview: record.sideChatPreview } : {}),
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
        if (current.hostId !== this.config.hostId || source.hostId !== this.config.hostId
          || (record.relationship.kind !== "subagent" && current.providerId !== source.providerId)) continue;
      } catch {
        continue;
      }
      const nativeMetadata: JsonObject = record.relationship.kind === "handoff" ? {
        ...(record.summary !== undefined ? { tethoqHandoffSummary: record.summary } : {}),
        ...(record.prompt !== undefined ? { tethoqHandoffPrompt: record.prompt } : {}),
        tethoqHandoffPending: record.pending,
      } : record.relationship.kind === "branch" || record.relationship.kind === "side_chat" ? {
        ...(record.bootstrap !== undefined ? { tethoqBranchBootstrap: record.bootstrap } : {}),
        tethoqBranchPending: record.pending,
      } : { tethoqObservedExternalLaunch: true };
      this.#cache.upsert({
        ...session,
        relationship: record.relationship,
        ...(record.relationship.kind === "side_chat" ? {
          sessionKind: "side_chat" as const,
          parentSessionId: record.relationship.sourceSessionId,
          ...(record.sideChatPreview !== undefined ? { preview: record.sideChatPreview } : {}),
        } : record.relationship.kind === "subagent" ? { parentSessionId: record.relationship.sourceSessionId } : {}),
        ...(record.summary !== undefined ? { contextHandoffSummary: record.summary } : {}),
        nativeMetadata: {
          ...session.nativeMetadata,
          ...transferMetadata(record.relationship),
          ...nativeMetadata,
          ...(record.relationship.kind === "side_chat" ? { tethoqSessionKind: "side_chat" } : {}),
        },
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

  public sideChats(parentSessionId?: string): readonly RemoteSession[] {
    if (parentSessionId !== undefined) this.assertSessionHost(parentSessionId);
    return this.sessions()
      .filter((session) => session.sessionKind === "side_chat")
      .filter((session) => parentSessionId === undefined || session.parentSessionId === parentSessionId)
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  public async listSideChatSessions(parentGlobalSessionId: string): Promise<readonly SideChatListItem[]> {
    this.assertActive();
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(parentGlobalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    const capabilities = await adapter.getCapabilities();
    // Re-attach persisted side-chat identity first so freshly listed sessions
    // are recognised even before the parent has been opened this run.
    this.restoreSessionTransferLinks();
    const nativeChildren = capabilities.sessionRelationships
      ? (await collectAllSessionPages(adapter, { parentProviderSessionId: providerSessionId, limit: 100 })).sessions
          .filter((session) => session.parentSessionId === parentGlobalSessionId)
      : [];
    const items = new Map<string, SideChatListItem>();
    for (const session of [...nativeChildren, ...this.sideChats(parentGlobalSessionId)]) {
      const item = this.sideChatItem(session, parentGlobalSessionId);
      if (item === undefined) continue;
      const existing = items.get(item.id);
      items.set(item.id, existing === undefined || item.preview !== undefined || existing.preview === undefined
        ? { ...existing, ...item }
        : { ...item, preview: existing.preview });
    }
    // Persisted transfer records keep finished side chats visible even after a
    // provider stops listing the session, so the task keeps its full history.
    for (const record of this.#sessionTransfers.values()) {
      if (record.relationship.kind !== "side_chat" || record.relationship.sourceSessionId !== parentGlobalSessionId) continue;
      if (items.has(record.sessionId)) continue;
      const item = this.sideChatTransferItem(record);
      if (item !== undefined) items.set(item.id, item);
    }
    return [...items.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private sideChatItem(session: RemoteSession, parentGlobalSessionId: string): SideChatListItem | undefined {
    const record = this.sideChatTransferFor(session.id, parentGlobalSessionId);
    if (session.sessionKind !== "side_chat"
      && session.relationship?.kind !== "side_chat"
      && session.nativeMetadata.tethoqSessionKind !== "side_chat"
      && record === undefined) return undefined;
    return {
      id: session.id,
      title: session.title,
      providerId: session.providerId,
      state: session.state,
      updatedAt: session.lastActivityAt,
      ...(session.preview?.trim()
        ? { preview: session.preview.trim().slice(0, 240) }
        : record?.sideChatPreview !== undefined
          ? { preview: record.sideChatPreview.slice(0, 240) }
          : {}),
    };
  }

  private sideChatTransferFor(sessionId: string, parentGlobalSessionId: string): SessionTransferRecord | undefined {
    const record = this.#sessionTransfers.get(sessionId);
    if (record?.relationship.kind === "side_chat" && record.relationship.sourceSessionId === parentGlobalSessionId) return record;
    return undefined;
  }

  private sideChatTransferItem(record: SessionTransferRecord): SideChatListItem | undefined {
    try {
      const { providerId } = parseGlobalSessionId(record.sessionId);
      return {
        id: record.sessionId,
        title: "Side chat",
        providerId,
        state: "unknown",
        updatedAt: "",
        ...(record.sideChatPreview !== undefined ? { preview: record.sideChatPreview.slice(0, 240) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  public async createSideChat(parentSessionId: string, prompt?: string, queuedMessageId?: string): Promise<SideChatResult> {
    if (queuedMessageId !== undefined) {
      return await this.withQueueMutation(queuedMessageId, async () =>
        await this.createSideChatInternal(parentSessionId, prompt, queuedMessageId));
    }
    return await this.createSideChatInternal(parentSessionId, prompt);
  }

  private async createSideChatInternal(parentSessionId: string, prompt?: string, queuedMessageId?: string): Promise<SideChatResult> {
    this.assertActive();
    const normalizedPrompt = prompt?.trim();
    if (prompt !== undefined && (!normalizedPrompt || normalizedPrompt.length > 100_000)) {
      throw new Error("A side-chat message must contain between 1 and 100000 characters");
    }
    const queued = queuedMessageId === undefined ? undefined : this.#queuedMessages.get(queuedMessageId);
    if (queuedMessageId !== undefined && (queued === undefined || queued.view.sessionId !== parentSessionId || queued.view.state === "sending")) {
      throw new Error("That queued instruction is no longer available for this task");
    }
    if (normalizedPrompt !== undefined && queued !== undefined) throw new Error("Choose either a new side-chat message or a queued instruction, not both");

    const { adapter, source, messages } = await this.transferSource(parentSessionId);
    if (source.sessionKind === "internal") throw new Error("Internal helper sessions cannot create side chats");
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.createSession || !capabilities.sendMessage) {
      throw new Error(`${adapter.displayName} cannot create a side chat`);
    }
    const relationship: SessionRelationship = { kind: "side_chat", sourceSessionId: parentSessionId, strategy: "transcript_bootstrap" };
    const fallback = branchBootstrap(source, messages);
    const bootstrap = sideChatBootstrap(fallback.content);
    const created = await adapter.createSession({
      workingDirectory: transferWorkingDirectory(source),
      title: `Side chat: ${source.title}`.slice(0, 120),
      ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
      ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
      ...(adapter.sessionCreationFeatures?.hiddenDeveloperInstructions === true
        ? { developerInstructions: sideChatDeveloperInstructions }
        : {}),
      metadata: { ...transferMetadata(relationship), tethoqSessionKind: "side_chat", parentSessionId },
    });
    const session: RemoteSession = {
      ...transferredSession(created, source, relationship, {
        tethoqBranchBootstrap: bootstrap,
        tethoqBranchPending: true,
        tethoqSessionKind: "side_chat",
      }),
      sessionKind: "side_chat",
      parentSessionId,
    };
    assertFreshTransferSession(source, session);
    this.#cache.upsert(session);
    this.#pendingBranchBootstraps.set(session.id, { bootstrap, relationship });
    this.#branchCopies.set(session.id, messages);
    this.rememberSessionTransfer({
      sessionId: session.id,
      relationship,
      pending: true,
      bootstrap,
      copiedMessages: persistableBranchMessages(messages),
    });
    this.appendSideChatEvent("side_chat.created", session, { sourceSessionId: parentSessionId });

    const initialRequest = queued?.request ?? (queued === undefined
      ? normalizedPrompt === undefined ? undefined : {
          requestId: `side_chat_${randomUUID()}`,
          content: normalizedPrompt,
          ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
          ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
        }
      : {
          requestId: `side_chat_${randomUUID()}`,
          content: queued.view.content,
          ...(queued.view.modelId !== undefined ? { modelId: queued.view.modelId } : {}),
          ...(queued.view.reasoningEffort !== undefined ? { reasoningEffort: queued.view.reasoningEffort } : {}),
        });
    if (initialRequest !== undefined) {
      await this.sendMessage(session.id, { ...initialRequest, requestId: `side_chat_${randomUUID()}` });
      this.#cache.updateState(session.id, "working", false);
      this.rememberSideChatPreview(session.id, initialRequest.content);
      if (queuedMessageId !== undefined) {
        const removed = await this.cancelQueuedMessageInternal(queuedMessageId, "moved_to_side_chat");
        if (!removed) throw new Error("The side chat was created, but its queued instruction could not be removed from the parent task");
      }
    }
    return { session: this.#cache.get(session.id) ?? session, copiedMessageCount: messages.length };
  }

  public async promoteSideChat(sessionId: string): Promise<BranchSessionResult> {
    const session = this.#cache.get(sessionId);
    if (session?.sessionKind !== "side_chat") throw new Error("Only a side chat can be promoted to a full task");
    const result = await this.branchSession(sessionId);
    const { parentSessionId: _parentSessionId, ...withoutParent } = result.session;
    const promoted: RemoteSession = {
      ...withoutParent,
      sessionKind: "task",
      nativeMetadata: { ...withoutParent.nativeMetadata, tethoqSessionKind: "task" },
    };
    this.#cache.upsert(promoted);
    this.appendSideChatEvent("side_chat.promoted", promoted, {
      sourceSideChatId: sessionId,
      promotionMode: "copy",
    });
    return { ...result, session: promoted };
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
    const copied = (source.relationship?.kind === "branch" || source.relationship?.kind === "side_chat") && source.relationship.strategy === "transcript_bootstrap"
      ? this.#branchCopies.get(sourceSessionId)
      : undefined;
    const messages = copied === undefined ? providerVisible : [...copyBranchMessages(copied, sourceSessionId), ...providerVisible];
    return { adapter, source, messages };
  }

  public async sendMessage(globalSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.assertActive();
    const prepared = withSimplifyResponseGuidance(await this.withGlobalAgentInstructions(globalSessionId, request));
    if (this.pendingContextHandoff(globalSessionId) !== undefined || this.pendingBranchBootstrap(globalSessionId) !== undefined) {
      return await this.withPendingHandoffSendLock(globalSessionId, async () =>
        await this.dispatchMessage(globalSessionId, prepared));
    }
    return await this.dispatchMessage(globalSessionId, prepared);
  }

  private async withGlobalAgentInstructions(globalSessionId: string, request: SendMessageRequest): Promise<SendMessageRequest> {
    const selected = await this.#globalAgentInstructions?.();
    let developerInstructions = request.developerInstructions;
    if (selected !== undefined) {
      const globalHeader = "Use these user-selected global AGENTS.md instructions for this Tethoq turn:";
      if (developerInstructions?.startsWith(`${globalHeader}\n\n`) !== true) {
        developerInstructions = developerInstructions === undefined
          ? `${globalHeader}\n\n${selected}`
          : `${globalHeader}\n\n${selected}\n\n${developerInstructions}`;
      }
    }
    if (this.#clientTooling !== undefined
      && this.#sessionMaySpawnForeignSubagents?.(globalSessionId) === true
      && developerInstructions?.includes(foreignSubagentMarker) !== true) {
      developerInstructions = developerInstructions === undefined
        ? foreignSubagentInstruction()
        : `${foreignSubagentInstruction()}\n\n${developerInstructions}`;
    }
    return developerInstructions === undefined || developerInstructions === request.developerInstructions
      ? request
      : { ...request, developerInstructions };
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
    const adapter = this.requireAdapter(providerId);
    const session = this.#cache.get(globalSessionId);
    let result: SendMessageResult;
    if (session?.externalWriter === true && (routedRequest.attachments?.length ?? 0) > 0) {
      if (adapter.sendMessageToExternalOwner === undefined) {
        throw new Error(`${adapter.displayName} cannot deliver attachments to an externally owned task`);
      }
      result = await adapter.sendMessageToExternalOwner(providerSessionId, routedRequest);
    } else {
      result = await adapter.sendMessage(providerSessionId, routedRequest);
    }
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
    if (result.accepted) {
      this.rememberSideChatPreview(globalSessionId, request.content);
      this.#cache.rememberRequestedSelection(globalSessionId, {
        ...(routedRequest.modelId !== undefined ? { modelId: routedRequest.modelId } : {}),
        ...(routedRequest.reasoningEffort !== undefined ? { reasoningEffort: routedRequest.reasoningEffort } : {}),
      });
    }
    this.invalidateMessageSnapshot(globalSessionId);
    return result;
  }

  private rememberSideChatPreview(sessionId: string, content: string): void {
    const record = this.#sessionTransfers.get(sessionId);
    if (record?.relationship.kind !== "side_chat" || record.sideChatPreview !== undefined) return;
    const preview = content.trim().replace(/\s+/gu, " ").slice(0, 1_000);
    if (preview.length === 0) return;
    const updated: SessionTransferRecord = { ...record, sideChatPreview: preview };
    this.#sessionTransfers.set(sessionId, updated);
    const session = this.#cache.get(sessionId);
    if (session !== undefined) {
      const withPreview = { ...session, preview };
      this.#cache.upsert(withPreview);
      this.appendSideChatEvent("side_chat.updated", withPreview);
    }
    this.#onSessionTransfersChange?.([...this.#sessionTransfers.values()]);
  }

  private appendSideChatEvent(
    type: "side_chat.created" | "side_chat.updated" | "side_chat.promoted",
    session: RemoteSession,
    details: JsonObject = {},
  ): void {
    this.#events.append({
      type,
      providerId: session.providerId,
      sessionId: session.id,
      payload: { ...details, session: session as unknown as JsonObject },
    });
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
    if ((session?.relationship?.kind !== "branch" && session?.relationship?.kind !== "side_chat")
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

  public async configureTranscriptionSource(
    sourceId: string,
    apiKey: string | undefined,
  ) {
    this.assertActive();
    if (apiKey !== undefined) await this.#transcriptionSources.validateCredential(sourceId, apiKey);
    if (this.#onTranscriptionCredentialChange === undefined) {
      throw new Error("Dictation credential storage is unavailable");
    }
    await this.#onTranscriptionCredentialChange(sourceId, apiKey);
    this.#transcriptionSources.setCredential(sourceId, apiKey);
    return this.#transcriptionSources.list();
  }

  public queuedMessages(sessionId?: string): readonly QueuedMessage[] {
    return [...this.#queuedMessages.values()]
      .map((record) => record.view)
      .filter((message) => sessionId === undefined || message.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public crossSessionTargets(sourceSessionId: string, query = "", limit = 20): readonly RemoteSession[] {
    this.assertActive();
    this.requireCrossSessionTask(sourceSessionId, "Source");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (query.length > 200) throw new Error("Task search must contain at most 200 characters");
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Task search limit must be an integer from 1 to 25");
    return this.#cache.all()
      .filter((session) => session.id !== sourceSessionId && this.isCrossSessionTask(session))
      .filter((session) => normalizedQuery.length === 0 || [
        session.title,
        session.project,
        session.workingDirectory,
        session.providerId,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery) === true))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  public crossSessionInbox(targetSessionId: string, limit = 100): readonly CrossSessionMessage[] {
    this.assertSessionHost(targetSessionId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Inbox limit must be an integer from 1 to 200");
    return [...this.#crossSessionMessages.values()]
      .filter((message) => message.envelope.targetSessionId === targetSessionId)
      .sort((left, right) => right.envelope.createdAt.localeCompare(left.envelope.createdAt) || right.envelope.id.localeCompare(left.envelope.id))
      .slice(0, limit);
  }

  public async sendCrossSessionMessage(
    sourceSessionId: string,
    targetSessionId: string,
    requestId: string,
    content: string,
  ): Promise<CrossSessionMessage> {
    this.assertActive();
    const source = this.requireCrossSessionTask(sourceSessionId, "Source");
    const target = this.requireCrossSessionTask(targetSessionId, "Target");
    if (source.id === target.id) throw new Error("A task cannot send a message to itself");
    const normalizedRequestId = requestId.trim();
    if (normalizedRequestId.length === 0 || normalizedRequestId.length > 256) {
      throw new Error("Cross-task request ID must contain between 1 and 256 characters");
    }
    if (content.trim().length === 0 || content.length > maxCrossSessionContentLength) {
      throw new Error(`Cross-task message must contain between 1 and ${maxCrossSessionContentLength} characters`);
    }
    const existing = [...this.#crossSessionMessages.values()].find((message) =>
      message.envelope.sourceSessionId === sourceSessionId && message.envelope.requestId === normalizedRequestId);
    if (existing !== undefined) {
      if (existing.envelope.targetSessionId !== targetSessionId || existing.envelope.content !== content) {
        throw new Error("That cross-task request ID was already used for a different message");
      }
      if (existing.state === "pending") await this.pumpCrossSessionInbox(targetSessionId);
      return this.#crossSessionMessages.get(existing.envelope.id) ?? existing;
    }
    this.pruneCrossSessionMessages(1);
    const pendingForTarget = [...this.#crossSessionMessages.values()].filter((message) =>
      message.envelope.targetSessionId === targetSessionId && (message.state === "pending" || message.state === "sending"));
    if (pendingForTarget.length >= maxPendingCrossSessionMessagesPerTarget) {
      throw new Error("That task already has too many pending cross-task messages");
    }
    const now = new Date().toISOString();
    const envelope: CrossSessionMessageEnvelope = {
      version: 1,
      id: `remote_${randomUUID()}`,
      requestId: normalizedRequestId,
      sourceSessionId,
      sourceTitle: source.title.trim().slice(0, 240) || "Tethoq task",
      targetSessionId,
      content,
      createdAt: now,
    };
    const record: CrossSessionMessage = { envelope, state: "pending", attemptCount: 0, updatedAt: now };
    this.#crossSessionMessages.set(envelope.id, record);
    try {
      await this.persistCrossSessionMessages();
    } catch (error) {
      this.#crossSessionMessages.delete(envelope.id);
      throw error;
    }
    await this.pumpCrossSessionInbox(targetSessionId);
    return this.#crossSessionMessages.get(envelope.id) ?? record;
  }

  public async enqueueMessage(
    globalSessionId: string,
    input: Omit<SendMessageRequest, "attachments"> & { readonly attachmentIds?: readonly string[] },
  ): Promise<QueuedMessage> {
    const prepared = withSimplifyResponseGuidance(input);
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    const session = this.#cache.get(globalSessionId);
    if (session === undefined) throw new Error("Session is not loaded on this bridge");
    const adapter = this.requireAdapter(providerId);
    if (adapter.enqueueQueuedMessage !== undefined && (input.attachmentIds?.length ?? 0) === 0 && (prepared.workflows?.length ?? 0) === 0) {
      const providerPrepared = await this.withGlobalAgentInstructions(globalSessionId, prepared);
      if (session.workingDirectory === undefined) throw new Error("This session does not expose a working directory for its desktop queue");
      const message = await adapter.enqueueQueuedMessage(providerSessionId, {
        requestId: providerPrepared.requestId,
        content: providerPrepared.content,
        ...(providerPrepared.developerInstructions !== undefined ? { developerInstructions: providerPrepared.developerInstructions } : {}),
        workingDirectory: session.workingDirectory,
        ...(prepared.modelId !== undefined ? { modelId: prepared.modelId } : {}),
        ...(prepared.reasoningEffort !== undefined ? { reasoningEffort: prepared.reasoningEffort } : {}),
      });
      const view = this.providerQueuedMessage(providerId, message);
      const previous = this.#queuedMessages.get(view.id)?.view;
      this.#queuedMessages.set(view.id, {
        view,
        providerOwned: true,
        providerMessageId: message.id,
        ...(message.developerInstructions !== undefined ? { request: { requestId: `provider_queue_${message.id}`, content: message.content, developerInstructions: message.developerInstructions } } : {}),
      });
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
      requestId: prepared.requestId,
      content: prepared.content,
      ...(prepared.developerInstructions !== undefined ? { developerInstructions: prepared.developerInstructions } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(prepared.workflows?.length ? { workflows: prepared.workflows } : {}),
    };
    const view: QueuedMessage = {
      id,
      sessionId: globalSessionId,
      content: prepared.content,
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
    return await this.withQueueMutation(messageId, async () =>
      await this.cancelQueuedMessageInternal(messageId, "cancelled"));
  }

  private async cancelQueuedMessageInternal(messageId: string, reason: string): Promise<boolean> {
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
      payload: { messageId, reason },
    });
    void this.pumpCrossSessionInbox(record.view.sessionId);
    return true;
  }

  public async editQueuedMessage(messageId: string, content: string): Promise<QueuedMessage> {
    const normalized = content.trim();
    if (normalized.length === 0 || normalized.length > 100_000) {
      throw new Error("Queued instructions must contain between 1 and 100000 characters");
    }
    return await this.withQueueMutation(messageId, async () => {
      const record = this.#queuedMessages.get(messageId);
      if (record === undefined || record.view.state === "sending") {
        throw new Error("That queued instruction is no longer available to edit");
      }
      if (record.providerOwned) {
        const { providerId, providerSessionId } = this.assertSessionHost(record.view.sessionId);
        const adapter = this.requireAdapter(providerId);
        if (adapter.updateQueuedMessage === undefined) {
          throw new Error(`${adapter.displayName} cannot edit this queued instruction in place`);
        }
        const updated = await adapter.updateQueuedMessage(providerSessionId, record.providerMessageId ?? messageId, normalized);
        if (updated === null) {
          this.#queuedMessages.delete(messageId);
          this.#events.append({
            type: "message.queue_removed",
            providerId,
            sessionId: record.view.sessionId,
            payload: { messageId, reason: "provider_removed" },
          });
          throw new Error("That queued instruction is no longer available to edit");
        }
        const view = this.providerQueuedMessage(providerId, updated);
        const previous = this.#queuedMessages.get(messageId)?.view;
        this.#queuedMessages.set(view.id, {
          view,
          providerOwned: true,
          providerMessageId: updated.id,
          ...(updated.developerInstructions !== undefined ? { request: { requestId: `provider_queue_${updated.id}`, content: updated.content, developerInstructions: updated.developerInstructions } } : {}),
        });
        if (view.id !== messageId) this.#queuedMessages.delete(messageId);
        if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(view)) {
          this.appendQueueEvent("message.queue_updated", view);
        }
        return view;
      }
      if (record.request === undefined) throw new Error("That queued instruction cannot be edited");
      const { error: _error, ...viewWithoutError } = record.view;
      record.view = { ...viewWithoutError, content: normalized, state: "queued" };
      record.request = { ...record.request, content: normalized };
      this.appendQueueEvent("message.queue_updated", record.view);
      return record.view;
    });
  }

  public async deliverQueuedMessage(messageId: string, mode: "send" | "steer"): Promise<boolean> {
    return await this.withQueueMutation(messageId, async () => {
      const record = this.#queuedMessages.get(messageId);
      if (record === undefined || record.view.state === "sending") {
        throw new Error("That queued instruction is no longer available");
      }
      const { providerId, providerSessionId } = this.assertSessionHost(record.view.sessionId);
      const adapter = this.requireAdapter(providerId);
      const session = this.#cache.get(record.view.sessionId);
      if (session === undefined) throw new Error("The target task is not loaded on this bridge");
      const active = session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
      if (mode === "steer" && session.state !== "working") throw new Error("This task is not currently working, so there is nothing to steer");
      if (mode === "send" && active) throw new Error("Wait for the active turn to finish, or steer this instruction instead");
      if (mode === "steer" && adapter.steerMessage === undefined) {
        if (!record.providerOwned || adapter.steerQueuedMessage === undefined) {
          throw new Error(`${adapter.displayName} does not support steering active work`);
        }
      }
      const providerOwnedSteer = mode === "steer" && record.providerOwned && adapter.steerQueuedMessage !== undefined;
      if (record.providerOwned && !providerOwnedSteer
        && (adapter.cancelQueuedMessage === undefined || adapter.restoreQueuedMessage === undefined)) {
        throw new Error(`${adapter.displayName} cannot safely move this queued instruction`);
      }

      const providerQueueSiblings = record.providerOwned
        ? [...this.#queuedMessages.values()]
            .filter((candidate) => candidate.providerOwned && candidate.view.sessionId === record.view.sessionId)
            .sort((left, right) => left.view.createdAt.localeCompare(right.view.createdAt) || left.view.id.localeCompare(right.view.id))
        : [];
      const providerQueueIndex = providerQueueSiblings.findIndex((candidate) => candidate === record);
      const beforeProviderMessageId = providerQueueIndex >= 0
        ? providerQueueSiblings[providerQueueIndex + 1]?.providerMessageId
        : undefined;
      const originalProviderMessage: ProviderQueuedMessage | undefined = record.providerOwned
        ? {
            id: record.providerMessageId ?? messageId,
            providerSessionId,
            content: record.view.content,
            state: "queued",
            createdAt: record.view.createdAt,
            ...(record.request?.developerInstructions !== undefined ? { developerInstructions: record.request.developerInstructions } : {}),
          }
        : undefined;

      const request: SendMessageRequest = {
        ...(record.request ?? {}),
        requestId: `queue_delivery_${randomUUID()}`,
        content: record.view.content,
        ...(record.view.modelId !== undefined ? { modelId: record.view.modelId } : {}),
        ...(record.view.reasoningEffort !== undefined ? { reasoningEffort: record.view.reasoningEffort } : {}),
      };
      let providerQueueRemoved = false;
      if (record.providerOwned && !providerOwnedSteer) {
        providerQueueRemoved = await adapter.cancelQueuedMessage!(providerSessionId, record.providerMessageId ?? messageId);
        if (!providerQueueRemoved) throw new Error("That queued instruction is no longer available");
        if (this.#queuedMessages.has(messageId)) {
          this.#queuedMessages.delete(messageId);
          this.#events.append({
            type: "message.queue_removed",
            providerId,
            sessionId: record.view.sessionId,
            payload: { messageId, reason: "delivering" },
          });
        }
      } else {
        record.view = { ...record.view, state: "sending" };
        this.appendQueueEvent("message.queue_updated", record.view);
      }

      try {
        const result = providerOwnedSteer
          ? await adapter.steerQueuedMessage!(providerSessionId, record.providerMessageId ?? messageId, request)
          : mode === "steer"
            ? await adapter.steerMessage!(providerSessionId, request)
          : await this.sendMessage(record.view.sessionId, request);
        if (!result.accepted) throw new Error(result.details.join(" ") || "The harness did not accept the queued instruction");
        if (this.#queuedMessages.has(messageId)) {
          this.#queuedMessages.delete(messageId);
          this.#events.append({
            type: "message.queue_removed",
            providerId,
            sessionId: record.view.sessionId,
            payload: { messageId, reason: mode === "steer" ? "steered" : "dispatched" },
          });
        }
        this.invalidateMessageSnapshot(record.view.sessionId);
        this.#cache.updateState(record.view.sessionId, "working", false);
        return true;
      } catch (error) {
        if (providerOwnedSteer) {
          // The provider owns the transaction and restores the exact native
          // composer record (including attachments/context) before rejecting.
          // Its queue change event repopulates this view if it was removed.
        } else if (record.providerOwned && providerQueueRemoved) {
          try {
            const restored = await adapter.restoreQueuedMessage!(providerSessionId, {
              requestId: `queue_restore_${randomUUID()}`,
              content: record.view.content,
              workingDirectory: session.workingDirectory ?? session.project ?? process.cwd(),
              originalMessage: originalProviderMessage!,
              ...(beforeProviderMessageId !== undefined ? { beforeMessageId: beforeProviderMessageId } : {}),
              ...(record.view.modelId !== undefined ? { modelId: record.view.modelId } : {}),
              ...(record.view.reasoningEffort !== undefined ? { reasoningEffort: record.view.reasoningEffort } : {}),
              ...(record.request?.developerInstructions !== undefined ? { developerInstructions: record.request.developerInstructions } : {}),
            });
            const restoredView = this.providerQueuedMessage(providerId, restored);
            const previous = this.#queuedMessages.get(restoredView.id)?.view;
            this.#queuedMessages.set(restoredView.id, {
              view: restoredView,
              providerOwned: true,
              providerMessageId: restored.id,
              ...(restored.developerInstructions !== undefined ? { request: { requestId: `provider_queue_${restored.id}`, content: restored.content, developerInstructions: restored.developerInstructions } } : {}),
            });
            if (previous === undefined) this.appendQueueEvent("message.queued", restoredView);
            else if (JSON.stringify(previous) !== JSON.stringify(restoredView)) {
              this.appendQueueEvent("message.queue_updated", restoredView);
            }
          } catch (restoreError) {
            throw new Error(`${error instanceof Error ? error.message : String(error)} The queued instruction could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
          }
        } else if (!record.providerOwned) {
          record.view = {
            ...record.view,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          this.appendQueueEvent("message.queue_updated", record.view);
        }
        throw error;
      } finally {
        void this.pumpCrossSessionInbox(record.view.sessionId);
      }
    });
  }

  public async moveQueuedMessageToNewTask(messageId: string, selection: QueuedTaskSelection): Promise<RemoteSession> {
    return await this.withQueueMutation(messageId, async () => {
      const record = this.#queuedMessages.get(messageId);
      if (record === undefined || record.view.state === "sending") {
        throw new Error("That queued instruction is no longer available");
      }
      const sourceSession = this.#cache.get(record.view.sessionId);
      if (sourceSession === undefined || sourceSession.sessionKind === "internal") {
        throw new Error("The queued instruction does not belong to an available task");
      }
      const providerId = selection.providerId.trim();
      const modelId = selection.modelId.trim();
      const reasoningEffort = selection.reasoningEffort?.trim();
      if (!providerId || !modelId) throw new Error("Choose an Agent and model for the new task");
      if (isAmbiguousQueueSelection(modelId) || (reasoningEffort !== undefined && isAmbiguousQueueSelection(reasoningEffort))) {
        throw new Error("Choose a concrete model and reasoning level for the new task");
      }
      const targetAdapter = this.requireAdapter(providerId);
      const capabilities = await targetAdapter.getCapabilities();
      if (!capabilities.createSession || !capabilities.sendMessage || targetAdapter.listModels === undefined) {
        throw new Error(`${targetAdapter.displayName} cannot start this as a new task`);
      }
      const selectedModel = (await this.listModels(providerId)).find((model) => model.id === modelId);
      if (selectedModel === undefined) throw new Error("The selected model is no longer available");
      const supportedEfforts = modelReasoningEfforts(selectedModel);
      if (reasoningEffort !== undefined && !supportedEfforts.includes(reasoningEffort)) {
        throw new Error("The selected reasoning level is not available for this model");
      }
      this.assertAttachmentProvider(providerId, record.request?.attachments);

      const { providerId: sourceProviderId, providerSessionId } = this.assertSessionHost(record.view.sessionId);
      const sourceAdapter = this.requireAdapter(sourceProviderId);
      const providerQueueSiblings = record.providerOwned
        ? [...this.#queuedMessages.values()]
            .filter((candidate) => candidate.providerOwned && candidate.view.sessionId === record.view.sessionId)
            .sort((left, right) => left.view.createdAt.localeCompare(right.view.createdAt) || left.view.id.localeCompare(right.view.id))
        : [];
      const providerQueueIndex = providerQueueSiblings.findIndex((candidate) => candidate === record);
      const beforeProviderMessageId = providerQueueIndex >= 0
        ? providerQueueSiblings[providerQueueIndex + 1]?.providerMessageId
        : undefined;
      const originalProviderMessage: ProviderQueuedMessage | undefined = record.providerOwned
        ? {
            id: record.providerMessageId ?? messageId,
            providerSessionId,
            content: record.view.content,
            state: "queued",
            createdAt: record.view.createdAt,
            ...(record.request?.developerInstructions !== undefined ? { developerInstructions: record.request.developerInstructions } : {}),
          }
        : undefined;
      if (record.providerOwned && (sourceAdapter.cancelQueuedMessage === undefined || sourceAdapter.restoreQueuedMessage === undefined)) {
        throw new Error(`${sourceAdapter.displayName} cannot safely move this queued instruction`);
      }

      const previousView = record.view;
      let providerQueueRemoved = false;
      if (record.providerOwned) {
        providerQueueRemoved = await sourceAdapter.cancelQueuedMessage!(providerSessionId, record.providerMessageId ?? messageId);
        if (!providerQueueRemoved) throw new Error("That queued instruction is no longer available");
      }
      record.view = { ...record.view, state: "sending" };
      this.appendQueueEvent("message.queue_updated", record.view);

      try {
        const title = record.view.content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 96) || "New task";
        const richRequest = (record.request?.attachments?.length ?? 0) > 0 || (record.request?.workflows?.length ?? 0) > 0;
        let session = await this.createSession(providerId, {
          workingDirectory: sourceSession.workingDirectory ?? sourceSession.project ?? process.cwd(),
          title,
          modelId,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(!richRequest ? {
            firstInstruction: record.view.content,
            ...(record.request?.developerInstructions !== undefined
              ? { firstInstructionDeveloperInstructions: record.request.developerInstructions }
              : {}),
          } : {}),
        });
        if (richRequest) {
          const result = await this.sendMessage(session.id, {
            ...(record.request ?? {}),
            requestId: `queue_new_task_${randomUUID()}`,
            content: record.view.content,
            modelId,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          });
          if (!result.accepted) throw new Error(result.details.join(" ") || "The new task did not accept the queued instruction");
          session = {
            ...session,
            title,
            preview: record.view.content.trim().slice(0, 240),
            state: "working",
            modelId,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            lastActivityAt: new Date().toISOString(),
          };
          this.#cache.upsert(session);
        }
        this.#queuedMessages.delete(messageId);
        this.#events.append({
          type: "message.queue_removed",
          providerId: sourceProviderId,
          sessionId: previousView.sessionId,
          payload: { messageId, reason: "moved_to_new_task", targetSessionId: session.id },
        });
        void this.pumpCrossSessionInbox(previousView.sessionId);
        return this.#cache.get(session.id) ?? session;
      } catch (error) {
        if (record.providerOwned && providerQueueRemoved) {
          try {
            const restored = await sourceAdapter.restoreQueuedMessage!(providerSessionId, {
              requestId: `queue_restore_${randomUUID()}`,
              content: previousView.content,
              workingDirectory: sourceSession.workingDirectory ?? sourceSession.project ?? process.cwd(),
              originalMessage: originalProviderMessage!,
              ...(beforeProviderMessageId !== undefined ? { beforeMessageId: beforeProviderMessageId } : {}),
              ...(previousView.modelId !== undefined ? { modelId: previousView.modelId } : {}),
              ...(previousView.reasoningEffort !== undefined ? { reasoningEffort: previousView.reasoningEffort } : {}),
              ...(record.request?.developerInstructions !== undefined ? { developerInstructions: record.request.developerInstructions } : {}),
            });
            const restoredView = this.providerQueuedMessage(sourceProviderId, restored);
            this.#queuedMessages.delete(messageId);
            this.#queuedMessages.set(restoredView.id, {
              view: restoredView,
              providerOwned: true,
              providerMessageId: restored.id,
              ...(restored.developerInstructions !== undefined
                ? { request: { requestId: `provider_queue_${restored.id}`, content: restored.content, developerInstructions: restored.developerInstructions } }
                : {}),
            });
            this.appendQueueEvent("message.queue_updated", restoredView);
          } catch (restoreError) {
            throw new Error(`${error instanceof Error ? error.message : String(error)} The queued instruction could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
          }
        } else {
          record.view = previousView;
          this.appendQueueEvent("message.queue_updated", record.view);
        }
        throw error;
      }
    });
  }

  public async steerMessage(
    globalSessionId: string,
    input: Omit<SendMessageRequest, "attachments"> & { readonly attachmentIds?: readonly string[] },
  ): Promise<SendMessageResult> {
    const prepared = withSimplifyResponseGuidance(input);
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
      requestId: prepared.requestId,
      content: prepared.content,
      ...(prepared.developerInstructions !== undefined ? { developerInstructions: prepared.developerInstructions } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(prepared.workflows?.length ? { workflows: prepared.workflows } : {}),
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
      const result = await adapter.steerMessage(providerSessionId, await this.withGlobalAgentInstructions(globalSessionId, request));
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
    const active = this.#interruptions.get(globalSessionId);
    if (active !== undefined) {
      await active;
      return;
    }
    const { providerId, providerSessionId, hostId } = parseGlobalSessionId(globalSessionId);
    if (hostId !== this.config.hostId) throw new Error("Session belongs to a different host");
    const adapter = this.requireAdapter(providerId);
    if (adapter.interrupt === undefined) throw new Error(`${providerId} does not support interruption`);
    const interruption = adapter.interrupt(providerSessionId);
    this.#interruptions.set(globalSessionId, interruption);
    try {
      await interruption;
    } finally {
      if (this.#interruptions.get(globalSessionId) === interruption) this.#interruptions.delete(globalSessionId);
    }
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
    const device = this.#pairing.listDevices().find((entry) => entry.credentialId === credentialId);
    const revoked = this.#pairing.revoke(credentialId);
    // Revoking must also disconnect. Without this the device keeps a live
    // tunnel and simply has every action refused, which is not what the user
    // asked for when they removed it.
    if (revoked && device !== undefined && !this.#pairing.listDevices().some((entry) => entry.deviceId === device.deviceId)) {
      for (const listener of this.#deviceRevokedListeners) listener(device.deviceId);
    }
    return revoked;
  }

  /** Device IDs whose access has been withdrawn and which must not reconnect. */
  public revokedDeviceIds(): readonly string[] {
    return this.#pairing.revokedDeviceIds();
  }

  public onDeviceRevoked(listener: (deviceId: string) => void): () => void {
    this.#deviceRevokedListeners.add(listener);
    return () => this.#deviceRevokedListeners.delete(listener);
  }

  public verifyDeviceAction<T extends JsonObject>(signed: SignedDeviceAction<T>): T {
    return this.#deviceVerifier.verify(signed).action;
  }

  /**
   * Confirms a credential is one this host issued and has not revoked. The
   * secure transport handshake needs this before it will agree a key with the
   * device that presented it.
   */
  public verifyDeviceCredential(credential: SignedCredential) {
    return this.#pairing.verifyCredential(credential);
  }

  public eventsSince(sequence: number): readonly AgentEvent[] {
    return this.#events.since(sequence);
  }

  public eventReplaySince(sequence: number): EventReplaySlice {
    return this.#events.replaySince(sequence);
  }

  public subscribeEventAppended(listener: () => void): () => void {
    return this.#events.subscribe(listener);
  }

  public async watchSession(globalSessionId: string): Promise<void> {
    this.assertActive();
    const { providerId, providerSessionId } = this.assertSessionHost(globalSessionId);
    this.#watchedSessionIds.add(globalSessionId);
    const adapter = this.requireAdapter(providerId);
    if (adapter.watchSession !== undefined) await adapter.watchSession(providerSessionId);
  }

  public unwatchSession(globalSessionId: string): void {
    if (!this.#watchedSessionIds.delete(globalSessionId)) return;
    try {
      const { providerId, providerSessionId } = parseGlobalSessionId(globalSessionId);
      const adapter = this.#adapters.get(providerId);
      adapter?.unwatchSession?.(providerSessionId);
      if (adapter !== undefined) void this.releaseProviderIfIdle(adapter);
    } catch {
      // Session ids from a closed view can be ignored once the watch set has dropped them.
    }
  }

  public latestSequence(): number {
    return this.#events.latestSequence();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#delegationTimer !== undefined) clearInterval(this.#delegationTimer);
    this.#delegationTimer = undefined;
    for (const timer of this.#resubscribeTimers.values()) clearTimeout(timer);
    this.#resubscribeTimers.clear();
    this.#resubscribeAttempts.clear();
    this.#events.append({ type: "host.disconnected", payload: {} });
    await Promise.allSettled(this.#subscriptions.map((subscription) => subscription.unsubscribe()));
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.dispose()));
    this.#subscriptions.length = 0;
    this.#messageSnapshots.clear();
    this.#watchedSessionIds.clear();
    this.#messageSnapshotGenerations.clear();
    this.#openSessionLoads.clear();
    this.#pendingContextHandoffs.clear();
    this.#pendingBranchBootstraps.clear();
    this.#branchCopies.clear();
    this.#pendingHandoffSends.clear();
    this.#providerConnectionErrors.clear();
    this.#queuedMessages.clear();
    this.#queuePumps.clear();
    this.#queueMutations.clear();
    this.#crossSessionMessages.clear();
    this.#crossSessionPumps.clear();
    this.#delegations.clear();
    this.#visionProxies.clear();
    this.#earsHelpers.clear();
    this.#earsHelperCreations.clear();
    this.#earsTranscriptionTails.clear();
    this.#earsJobs.clear();
    this.#interruptions.clear();
    this.#internalSessionIds.clear();
    this.#internalSessionCreations.clear();
    this.#pendingExternalLaunches.splice(0);
  }

  private async receiveProviderEvent(event: ProviderEvent): Promise<void> {
    const internalCreation = this.#internalSessionCreations.get(event.providerId);
    if (internalCreation !== undefined) {
      internalCreation.events.push(event);
      return;
    }
    if (!this.#deduper.accept(`${event.providerId}:${event.eventId}`)) return;
    this.#refresh.noteProviderEvent(event.providerId);
    if (event.type === "message.queue_updated" && Array.isArray(event.payload.messages)) {
      this.syncProviderQueue(event.providerId, event.payload.messages);
      return;
    }
    const globalSessionId = event.providerSessionId === undefined ? undefined : makeGlobalSessionId(this.config.hostId, event.providerId, event.providerSessionId);
    if (globalSessionId !== undefined && this.#internalSessionIds.has(globalSessionId)) return;
    let payload: JsonObject = event.payload;
    if (globalSessionId !== undefined && (event.type === "command.started" || event.type === "command.completed")) {
      const launches = observedExternalLaunchesFromPayload(event.payload);
      if (launches.length > 0) {
        this.rememberExternalLaunches(globalSessionId, launches);
        this.linkObservedExternalSessions(this.#pendingExternalLaunches);
      }
    }
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
        const providerStatus = providerStatusFromPayload(event.payload);
        if (providerStatus !== undefined) this.#cache.updateProviderStatus(globalSessionId, providerStatus);
        else if (state !== "working") this.#cache.updateProviderStatus(globalSessionId, null);
      } else if (event.type === "session.updated") {
        const patch = sessionMetadataPatch(event.payload, this.config.hostId, event.providerId);
        this.#cache.updateMetadata(globalSessionId, patch);
        // A harness announcing its model or reasoning level is the authority on
        // what the session runs, and worth keeping so the next start is not blind.
        this.#cache.rememberReportedSelection(globalSessionId, {
          ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
          ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
        });
      } else if (event.type === "message.started" || event.type === "message.delta" || event.type === "tool.started" || event.type === "command.started") this.#cache.updateState(globalSessionId, "working", false);
      else if (event.type === "agent.completed") this.#cache.updateState(globalSessionId, "completed", false);
      else if (event.type === "agent.error") this.#cache.updateState(globalSessionId, "failed", false);
      else if (event.type === "agent.interrupted") this.#cache.updateState(globalSessionId, "idle", false);
      if (providerEventClearsProviderStatus(event)) this.#cache.updateProviderStatus(globalSessionId, null);
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
      void this.pumpCrossSessionInbox(globalSessionId);
      void this.pumpDelegationsForSession(globalSessionId);
      void this.releaseProviderIfIdle(this.requireAdapter(event.providerId));
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
        content: hiddenProviderControlContent(`mesh-result:${runtime.task.id}`),
        developerInstructions: delegationSynthesisInstruction(runtime.task, reports, this.#clientTooling !== undefined),
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

  /**
   * Provider session listings lag live turns, so a freshly created delegated
   * child is often listed as idle while its first turn is still running. A
   * reconcile must not downgrade a child the delegation bookkeeping still
   * tracks and whose cached state already says working; provider events and
   * the delegation completion path settle the state for real.
   */
  private delegatedChildTurnInFlight(sessionId: string): boolean {
    if (this.#cache.get(sessionId)?.state !== "working") return false;
    return [...this.#delegations.values()].some((runtime) =>
      runtime.task.state !== "completed" && runtime.task.state !== "failed"
      && runtime.task.children.some((child) => child.sessionId === sessionId));
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
    const inFlight = this.#connectPromises.get(adapter.providerId);
    if (inFlight !== undefined) return await inFlight;
    const attempt = this.connectProviderOnce(adapter).finally(() => {
      this.#connectPromises.delete(adapter.providerId);
    });
    this.#connectPromises.set(adapter.providerId, attempt);
    await attempt;
  }

  private async connectProviderOnce(adapter: AgentProviderAdapter): Promise<void> {
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
      this.#resubscribeAttempts.delete(adapter.providerId);
      this.#events.append({ type: "provider.connected", providerId: adapter.providerId, payload: {} });
      await this.releaseProviderIfIdle(adapter);
    } catch (error) {
      const providerError = providerErrorFromUnknown(adapter.providerId, error);
      this.#providerConnectionErrors.set(adapter.providerId, providerError);
      this.#events.append({
        type: "provider.disconnected",
        providerId: adapter.providerId,
        payload: { code: providerError.code, message: providerError.message },
      });
      // The tool this app starts for you is not listening yet when the first
      // attempt runs, and that first attempt used to be the only one: nothing
      // re-ran it, so a harness that came up a second later stayed recorded as
      // missing for the whole session, taking the composer's send with it. Every
      // failure now books its own next attempt, and the success emits
      // provider.connected, which is what tells the window to look again.
      this.scheduleProviderResubscribe(adapter.providerId);
      throw error;
    }
  }

  /**
   * A detected provider without a live subscription has no way to recover on its
   * own: nothing re-runs connectProvider unless a refresh happens to notice it.
   * Schedule one bounded re-connect so the next providerConnections() reading
   * reports online. Failures keep the bridge quiet (connectProvider already
   * emits provider.disconnected), and a success emits provider.connected, which
   * is the renderer's signal to refresh its snapshot.
   */
  private scheduleProviderResubscribe(providerId: string): void {
    if (this.#disposed || this.#resubscribeTimers.has(providerId)) return;
    // A tool that is starting up answers within a few seconds, so the first
    // retries come quickly; one that is simply not installed on this machine
    // backs off toward a slow heartbeat rather than being probed forever at
    // full speed. A success resets this, so a later stumble recovers fast again.
    const attempt = this.#resubscribeAttempts.get(providerId) ?? 0;
    this.#resubscribeAttempts.set(providerId, attempt + 1);
    const delay = Math.min(resubscribeCooldownMs * 2 ** attempt, maximumResubscribeCooldownMs);
    const timer = setTimeout(() => {
      this.#resubscribeTimers.delete(providerId);
      if (this.#disposed) return;
      const adapter = this.#adapters.get(providerId);
      if (adapter === undefined) return;
      void this.connectProvider(adapter).catch(() => undefined);
    }, delay);
    timer.unref();
    this.#resubscribeTimers.set(providerId, timer);
  }

  private providerUnavailableError(adapter: AgentProviderAdapter, detection: ProviderDetection): ProviderAdapterError {
    const message = detection.details.map((detail) => detail.trim()).filter(Boolean).join(" ") || `${adapter.displayName} is not available on this host.`;
    return new ProviderAdapterError(adapter.providerId, "PROVIDER_UNAVAILABLE", message, true);
  }

  private async withIdleRelease<T>(adapter: AgentProviderAdapter, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      await this.releaseProviderIfIdle(adapter);
    }
  }

  private async releaseProviderIfIdle(adapter: AgentProviderAdapter): Promise<void> {
    if (this.#disposed || adapter.releaseIdleResources === undefined) return;
    const hasWatchedSession = [...this.#watchedSessionIds].some((sessionId) => {
      try {
        return parseGlobalSessionId(sessionId).providerId === adapter.providerId;
      } catch {
        return false;
      }
    });
    if (hasWatchedSession) return;
    const hasLiveSession = this.#cache.all().some((session) =>
      session.providerId === adapter.providerId &&
      (session.state === "working" || session.state === "needs_approval" || session.state === "needs_input"));
    if (hasLiveSession) return;
    await adapter.releaseIdleResources().catch(() => undefined);
  }

  /**
   * A provider we cannot reach right now.
   *
   * Reaching a coding tool and being able to send to it are different questions,
   * and answering the first badly used to settle the second: any failure here -
   * a probe that timed out, an auth read that blipped, a server mid-restart -
   * reported every capability as false, and a capability list without
   * sendMessage is what puts "cannot accept messages right now" in front of
   * someone whose tool is running perfectly well. The failure also outlived the
   * blip, because the next answer only arrived on the next refresh.
   *
   * So a tool that has told us what it can do keeps that answer. It is reported
   * offline with the real error attached, which is what the task list and the
   * provider list read, and what still holds back starting new work there. What
   * it no longer does is quietly withdraw the ability to write into a
   * conversation that is open in front of someone: if the tool really has gone,
   * the send itself says so, in the provider's own words, and the moment the
   * tool answers again this clears on its own. A tool that has never answered is
   * unchanged - nothing is known about it, so nothing is claimed.
   */
  private unreachableProvider(adapter: AgentProviderAdapter, error: unknown): ProviderConnection {
    const known = this.#lastGoodCapabilities.get(adapter.providerId);
    return {
      providerId: adapter.providerId,
      displayName: adapter.displayName,
      state: "offline",
      detected: known !== undefined,
      authenticated: null,
      capabilities: known ?? this.unavailableProviderCapabilities(),
      lastError: providerErrorFromUnknown(adapter.providerId, error),
    };
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

  private rememberCompactionThreshold(globalSessionId: string, threshold: number): void {
    this.#compactionThresholds.delete(globalSessionId);
    this.#compactionThresholds.set(globalSessionId, threshold);
    while (this.#compactionThresholds.size > maximumCompactionThresholds) {
      const oldest = this.#compactionThresholds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#compactionThresholds.delete(oldest);
    }
  }

  private async persistCompactionThresholds(): Promise<void> {
    await this.#onCompactionThresholdsChange?.(Object.fromEntries(this.#compactionThresholds));
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
      await this.compactSession(globalSessionId, "automatic");
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
      this.#queuedMessages.set(view.id, {
        view,
        providerOwned: true,
        providerMessageId: message.id,
        ...(message.developerInstructions !== undefined ? { request: { requestId: `provider_queue_${message.id}`, content: message.content, developerInstructions: message.developerInstructions } } : {}),
      });
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
      attachments: (message.attachments ?? []).flatMap((attachment) => {
        if (!attachment || typeof attachment.name !== "string" || typeof attachment.mimeType !== "string"
          || typeof attachment.byteLength !== "number" || !Number.isFinite(attachment.byteLength) || attachment.byteLength < 0) return [];
        return [{
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          ...(typeof attachment.dataUrl === "string" ? { dataUrl: attachment.dataUrl } : {}),
          ...(typeof attachment.durationSeconds === "number" && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0
            ? { durationSeconds: attachment.durationSeconds }
            : {}),
        }];
      }),
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
  }

  private sessionHoldsFollowUpQueue(globalSessionId: string): boolean {
    const session = this.#cache.get(globalSessionId);
    if (session === undefined) return false;
    if (session.state === "working" || session.state === "needs_approval" || session.state === "needs_input"
      || session.state === "disconnected" || session.state === "unknown") {
      return true;
    }
    try {
      return this.requireAdapter(session.providerId).hasActiveTurn?.(session.providerSessionId) === true;
    } catch {
      return false;
    }
  }

  private async pumpQueue(globalSessionId: string): Promise<void> {
    if (this.#queuePumps.has(globalSessionId) || this.#disposed) return;
    if (this.sessionHoldsFollowUpQueue(globalSessionId)) return;
    const next = [...this.#queuedMessages.values()]
      .filter((record) => !record.providerOwned
        && !this.#queueMutations.has(record.view.id)
        && record.view.sessionId === globalSessionId
        && record.view.state === "queued")
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
      void this.pumpCrossSessionInbox(globalSessionId);
    }
  }

  private async reconcileCrossSessionDeliveries(): Promise<void> {
    const recovering = [...this.#crossSessionMessages.values()]
      .filter((message) => message.state === "sending");
    if (recovering.length === 0) return;

    const previous = new Map(recovering.map((message) => [message.envelope.id, message]));
    const recoveredEvents: CrossSessionMessage[] = [];
    let changed = false;
    for (const targetSessionId of new Set(recovering.map((message) => message.envelope.targetSessionId))) {
      const target = this.#cache.get(targetSessionId);
      if (target === undefined || !this.isCrossSessionTask(target)) continue;
      try {
        const { providerId, providerSessionId } = this.assertSessionHost(targetSessionId);
        const messages = await this.requireAdapter(providerId).getMessages(providerSessionId);
        for (const record of recovering.filter((message) => message.envelope.targetSessionId === targetSessionId)) {
          const match = messages.find((message) => isCrossSessionDeliveryMessage(message, record.envelope));
          const now = new Date().toISOString();
          const { error: _error, ...withoutError } = record;
          if (match === undefined) {
            this.#crossSessionMessages.set(record.envelope.id, {
              ...withoutError,
              state: "pending",
              updatedAt: now,
            });
          } else {
            const deliveryRequestId = crossSessionDeliveryRequestId(record.envelope.id);
            const delivered: CrossSessionMessage = {
              ...withoutError,
              state: "delivered",
              updatedAt: now,
              deliveredAt: now,
              providerMessageIds: [...new Set([
                deliveryRequestId,
                record.envelope.id,
                match.id,
                match.providerMessageId,
              ])],
            };
            this.#crossSessionMessages.set(record.envelope.id, delivered);
            recoveredEvents.push(delivered);
          }
          changed = true;
        }
      } catch {
        // Keep an unknown in-flight delivery durable until its provider can be inspected.
      }
    }
    if (!changed) return;
    try {
      await this.persistCrossSessionMessages();
    } catch {
      for (const [envelopeId, record] of previous) this.#crossSessionMessages.set(envelopeId, record);
      return;
    }
    for (const delivered of recoveredEvents) {
      this.invalidateMessageSnapshot(delivered.envelope.targetSessionId);
      this.#events.append({
        type: "message.remote_received",
        sessionId: delivered.envelope.targetSessionId,
        payload: delivered as unknown as JsonObject,
      });
    }
  }

  private async pumpCrossSessionInbox(targetSessionId: string): Promise<void> {
    if (this.#crossSessionPumps.has(targetSessionId) || this.#disposed) return;
    const target = this.#cache.get(targetSessionId);
    if (target === undefined || !this.isCrossSessionTask(target)) return;
    if (target.state === "working" || target.state === "needs_approval" || target.state === "needs_input"
      || target.state === "disconnected" || target.state === "unknown") return;
    if (this.hasPendingUserQueue(targetSessionId) || this.#queuePumps.has(targetSessionId)) return;
    const next = [...this.#crossSessionMessages.values()]
      .filter((message) => message.envelope.targetSessionId === targetSessionId && message.state === "pending")
      .sort((left, right) => left.envelope.createdAt.localeCompare(right.envelope.createdAt) || left.envelope.id.localeCompare(right.envelope.id))[0];
    if (next === undefined) return;
    this.#crossSessionPumps.add(targetSessionId);
    const sending: CrossSessionMessage = {
      ...next,
      state: "sending",
      attemptCount: next.attemptCount + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#crossSessionMessages.set(next.envelope.id, sending);
    try {
      await this.persistCrossSessionMessages();
      // A user can enqueue while the durable state write is in flight. Recheck
      // immediately before provider dispatch so user-authored work stays first.
      if (this.hasPendingUserQueue(targetSessionId) || this.#queuePumps.has(targetSessionId)) {
        this.#crossSessionMessages.set(next.envelope.id, { ...sending, state: "pending", updatedAt: new Date().toISOString() });
        await this.persistCrossSessionMessages();
        return;
      }
      const persisted = this.#crossSessionMessages.get(next.envelope.id);
      if (persisted?.state !== "sending" || !sameCrossSessionEnvelope(persisted.envelope, next.envelope)) {
        throw new Error("Cross-task delivery envelope no longer matches its persisted inbox record");
      }
      const deliveryRequestId = crossSessionDeliveryRequestId(next.envelope.id);
      const result = await this.sendMessage(targetSessionId, {
        requestId: deliveryRequestId,
        content: crossSessionDispatchContent(next.envelope),
        metadata: {
          tethoqMessageKind: "cross_session",
          tethoqEnvelopeVersion: 1,
          tethoqEnvelopeId: next.envelope.id,
          tethoqSourceSessionId: next.envelope.sourceSessionId,
        },
      });
      if (!result.accepted) throw new Error(result.details.join(" ") || "The target harness did not accept the cross-task message");
      const deliveredAt = new Date().toISOString();
      const delivered: CrossSessionMessage = {
        ...sending,
        state: "delivered",
        updatedAt: deliveredAt,
        deliveredAt,
        providerMessageIds: [...new Set([deliveryRequestId, next.envelope.id, ...(result.providerTurnId === undefined ? [] : [result.providerTurnId])])],
      };
      this.#crossSessionMessages.set(next.envelope.id, delivered);
      this.#cache.updateState(targetSessionId, "working", false);
      this.invalidateMessageSnapshot(targetSessionId);
      await this.persistCrossSessionMessages();
      this.#events.append({
        type: "message.remote_received",
        sessionId: targetSessionId,
        payload: delivered as unknown as JsonObject,
      });
    } catch (error) {
      const current = this.#crossSessionMessages.get(next.envelope.id);
      if (current?.state !== "delivered") {
        const failed: CrossSessionMessage = {
          ...(current ?? sending),
          state: "failed",
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        };
        this.#crossSessionMessages.set(next.envelope.id, failed);
        await this.persistCrossSessionMessages().catch(() => undefined);
      }
    } finally {
      this.#crossSessionPumps.delete(targetSessionId);
    }
  }

  private hasPendingUserQueue(sessionId: string): boolean {
    return [...this.#queuedMessages.values()].some((record) =>
      record.view.sessionId === sessionId && (record.view.state === "queued" || record.view.state === "sending"));
  }

  private async withQueueMutation<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#queueMutations.has(messageId)) throw new Error("That queued instruction is already being changed");
    this.#queueMutations.add(messageId);
    try {
      return await operation();
    } finally {
      this.#queueMutations.delete(messageId);
    }
  }

  private isCrossSessionTask(session: RemoteSession): boolean {
    return !this.#internalSessionIds.has(session.id) && (session.sessionKind === undefined || session.sessionKind === "task");
  }

  private requireCrossSessionTask(sessionId: string, label: string): RemoteSession {
    this.assertSessionHost(sessionId);
    const session = this.#cache.get(sessionId);
    if (session === undefined) throw new Error(`${label} task is not loaded on this bridge`);
    if (this.#internalSessionIds.has(sessionId) || session.sessionKind === "internal") {
      throw new Error(`${label} task is an internal helper session`);
    }
    if (session.sessionKind === "side_chat") throw new Error(`${label} task is a side chat`);
    return session;
  }

  private decorateCrossSessionMessages(sessionId: string, messages: readonly RemoteMessage[]): readonly RemoteMessage[] {
    const inbox = new Map([...this.#crossSessionMessages.values()]
      .filter((message) => message.state === "delivered" && message.envelope.targetSessionId === sessionId)
      .map((message) => [message.envelope.id, message]));
    if (inbox.size === 0) return messages;
    return messages.map((message) => {
      if (message.role !== "user") return message;
      const markerId = message.parts.flatMap((part) => part.type === "text" ? [crossSessionMarkerId(part.text)] : []).find((id) => id !== undefined);
      if (markerId === undefined) return message;
      const persisted = inbox.get(markerId);
      if (persisted === undefined || crossSessionDispatchContent(persisted.envelope) !== message.parts.find((part) => part.type === "text")?.text) return message;
      return {
        ...message,
        parts: message.parts.map((part) => part.type === "text" && part.text === crossSessionDispatchContent(persisted.envelope)
          ? { ...part, text: persisted.envelope.content }
          : part),
        origin: {
          kind: "cross_session",
          envelopeId: persisted.envelope.id,
          sourceSessionId: persisted.envelope.sourceSessionId,
          sourceTitle: persisted.envelope.sourceTitle,
        },
      };
    });
  }

  private pruneCrossSessionMessages(incoming: number): void {
    const removeCount = Math.max(0, this.#crossSessionMessages.size + incoming - maxCrossSessionMessages);
    if (removeCount === 0) return;
    const removable = [...this.#crossSessionMessages.values()]
      .filter((message) => message.state === "delivered" || message.state === "failed")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.envelope.id.localeCompare(right.envelope.id));
    if (removable.length < removeCount) throw new Error("Cross-task inbox is full of pending messages");
    for (const message of removable.slice(0, removeCount)) this.#crossSessionMessages.delete(message.envelope.id);
  }

  private async persistCrossSessionMessages(): Promise<void> {
    await this.#onCrossSessionMessagesChange?.([...this.#crossSessionMessages.values()]
      .sort((left, right) => left.envelope.createdAt.localeCompare(right.envelope.createdAt) || left.envelope.id.localeCompare(right.envelope.id)));
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
    this.requireAdapter(selection.providerId);
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
    for (const attachment of attachments) {
      const mimeType = attachment.mimeType.toLowerCase();
      if (mimeType.startsWith("image/")) continue;
      if (mimeType.startsWith("audio/") && (providerId === "direct" || providerId === "codex")) continue;
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

  private async ensureEarsHelperSession(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly reasoningEffort?: string;
  }, staleHelperId?: string): Promise<RemoteSession> {
    const key = earsModelKey(input.providerId, input.modelId);
    const pending = this.#earsHelperCreations.get(key);
    if (pending !== undefined) return await pending;
    const creation = this.resolveEarsHelperSession(key, input, staleHelperId);
    this.#earsHelperCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.#earsHelperCreations.get(key) === creation) this.#earsHelperCreations.delete(key);
    }
  }

  private async resolveEarsHelperSession(
    key: string,
    input: {
      readonly providerId: string;
      readonly modelId: string;
      readonly reasoningEffort?: string;
    },
    staleHelperId?: string,
  ): Promise<RemoteSession> {
    const adapter = this.requireAdapter(input.providerId);
    const existingId = this.#earsHelpers.get(key);
    if (existingId !== undefined) {
      if (existingId === staleHelperId) {
        this.discardEarsHelper(key, existingId);
      } else {
        try {
          const { providerSessionId } = parseGlobalSessionId(existingId);
          const existing = this.asEarsHelper(await adapter.getSession(providerSessionId), input);
          this.#internalSessionIds.add(existing.id);
          this.#cache.upsert(existing);
          return existing;
        } catch (error) {
          if (!isMissingProviderSessionError(error)) throw error;
          this.discardEarsHelper(key, existingId);
        }
      }
    }
    this.beginInternalSessionCreation(adapter.providerId);
    let created: RemoteSession;
    try {
      created = await adapter.createSession({
        workingDirectory: this.#internalHelperWorkingDirectory,
        title: "EARS",
        modelId: input.modelId,
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ephemeral: adapter.sessionCreationFeatures?.ephemeralSessions === true,
        ...(adapter.sessionCreationFeatures?.selectableClientTools === true ? { clientTools: "none" as const } : {}),
        mcpServers: "none",
        metadata: { internalPurpose: "ears" },
      });
      this.#internalSessionIds.add(created.id);
    } finally {
      await this.finishInternalSessionCreation(adapter.providerId);
    }
    const helper = this.asEarsHelper(created, input);
    this.#earsHelpers.set(key, helper.id);
    this.notifyEarsHelpersChange();
    this.#internalSessionIds.add(helper.id);
    this.#cache.upsert(helper);
    return helper;
  }

  private asEarsHelper(
    session: RemoteSession,
    input: { readonly modelId: string; readonly reasoningEffort?: string },
  ): RemoteSession {
    const { parentSessionId: _parentSessionId, relationship: _relationship, ...unparented } = session;
    return {
      ...unparented,
      sessionKind: "internal",
      agentNickname: "EARS",
      agentRole: "ears",
      modelId: input.modelId,
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      nativeMetadata: { ...session.nativeMetadata, internal: true, internalPurpose: "ears" },
    };
  }

  private discardEarsHelper(key: string, helperId: string): void {
    if (this.#earsHelpers.get(key) === helperId) {
      this.#earsHelpers.delete(key);
      this.notifyEarsHelpersChange();
    }
    this.#internalSessionIds.delete(helperId);
    this.#cache.delete(helperId);
  }

  private notifyEarsHelpersChange(): void {
    this.#onEarsHelpersChange?.(Object.fromEntries(this.#earsHelpers));
  }

  private async withEarsTranscriptionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#earsTranscriptionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#earsTranscriptionTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#earsTranscriptionTails.get(key) === tail) this.#earsTranscriptionTails.delete(key);
    }
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
    label = "Visual support",
    isCancelled?: () => boolean,
  ): Promise<string> {
    const adapter = this.requireAdapter(providerId);
    const priorAssistantIds = new Set(before.filter((message) => message.role === "assistant").map((message) => message.id));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (isCancelled?.()) throw new Error(label === "EARS" ? earsCancelledMessage : `${label} was cancelled`);
      const messages = await adapter.getMessages(providerSessionId);
      if (isCancelled?.()) throw new Error(label === "EARS" ? earsCancelledMessage : `${label} was cancelled`);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role !== "assistant" || priorAssistantIds.has(message.id) || message.status === "streaming") continue;
        const text = message.parts.flatMap((part) => part.type === "text" ? [part.text.trim()] : []).filter(Boolean).join("\n");
        if (text.length > 0) return text;
      }
      const sliceEnd = Date.now() + 250;
      while (Date.now() < sliceEnd) {
        if (isCancelled?.()) throw new Error(label === "EARS" ? earsCancelledMessage : `${label} was cancelled`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`${label} did not return a result before the timeout`);
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("Agent Bridge has been disposed");
  }
}

function earsEffortsFromModel(model: RemoteModel): readonly string[] {
  const raw = model.nativeMetadata.supportedReasoningEfforts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      const value = item.reasoningEffort ?? item.id;
      return typeof value === "string" && value.trim() ? [value] : [];
    }
    return [];
  });
}

function isMissingProviderSessionError(error: unknown): boolean {
  if (error instanceof ProviderAdapterError) {
    return error.code === "SESSION_NOT_FOUND" || error.code === "HTTP_404";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread not found\b/iu.test(message);
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

function normalizedLaunchPath(value: string | undefined): string {
  return (value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function externalLaunchSignature(launch: ObservedExternalSessionLaunch): string {
  const observed = Date.parse(launch.observedAt);
  const timeBucket = Number.isFinite(observed) ? Math.floor(observed / (10 * 60_000)) : -1;
  return [
    launch.targetProviderId.toLowerCase(),
    launch.title.trim().toLowerCase(),
    normalizedLaunchPath(launch.workingDirectory),
    (launch.modelId ?? "").trim().toLowerCase(),
    String(timeBucket),
  ].join("\u0000");
}

function externalLaunchMatchesSession(launch: ParentObservedExternalLaunch, session: RemoteSession): boolean {
  if (launch.targetProviderId !== session.providerId || launch.workingDirectory === undefined || session.createdAt === undefined) return false;
  if (launch.title.trim().toLowerCase() !== session.title.trim().toLowerCase()) return false;
  if (normalizedLaunchPath(launch.workingDirectory) !== normalizedLaunchPath(session.workingDirectory)) return false;
  if (launch.modelId !== undefined && session.modelId !== undefined
    && launch.modelId.trim().toLowerCase() !== session.modelId.trim().toLowerCase()) return false;
  const observed = Date.parse(launch.observedAt);
  const created = Date.parse(session.createdAt);
  return Number.isFinite(observed) && Number.isFinite(created)
    && created >= observed - 30_000 && created <= observed + externalLaunchMatchWindowMs;
}

function observedExternalLaunchesFromPayload(payload: JsonObject): ObservedExternalSessionLaunch[] {
  const value = payload.externalSessionLaunches;
  if (!Array.isArray(value)) return [];
  const launches: ObservedExternalSessionLaunch[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.targetProviderId !== "string" || typeof item.title !== "string" || typeof item.observedAt !== "string") continue;
    if (!item.targetProviderId.trim() || !item.title.trim() || !Number.isFinite(Date.parse(item.observedAt))) continue;
    launches.push({
      targetProviderId: item.targetProviderId.trim(),
      title: item.title.trim(),
      observedAt: item.observedAt,
      ...(typeof item.workingDirectory === "string" && item.workingDirectory.trim() ? { workingDirectory: item.workingDirectory.trim() } : {}),
      ...(typeof item.modelId === "string" && item.modelId.trim() ? { modelId: item.modelId.trim() } : {}),
    });
  }
  return launches;
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

function providerStatusFromPayload(
  payload: JsonObject,
): NonNullable<RemoteSession["providerStatus"]> | null | undefined {
  if (!Object.hasOwn(payload, "providerStatus")) return undefined;
  const value = payload.providerStatus;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.kind !== "retry" || typeof value.message !== "string" || value.message.trim().length === 0) return undefined;
  const retryAt = typeof value.retryAt === "string" && value.retryAt.trim().length > 0 ? value.retryAt.trim() : undefined;
  return {
    kind: "retry",
    message: value.message.trim(),
    ...(retryAt !== undefined ? { retryAt } : {}),
  };
}

function providerEventClearsProviderStatus(event: ProviderEvent): boolean {
  if (event.type === "message.started") {
    const info = event.payload.info;
    const role = typeof event.payload.role === "string"
      ? event.payload.role
      : typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.role === "string"
        ? info.role
        : undefined;
    return role === "assistant";
  }
  if (event.type === "message.delta") return typeof event.payload.text === "string" && event.payload.text.length > 0;
  if (event.type === "message.completed") return true;
  return event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.completed"
    || event.type === "command.started" || event.type === "command.output" || event.type === "command.completed"
    || event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error";
}

function normalizedMetadataValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredMeshString(input: JsonObject, key: string, maximum = 32_000): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${key} must contain between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function optionalMeshString(input: JsonObject, key: string, maximum: number): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${key} must contain at most ${maximum} characters`);
  return value;
}

function optionalMeshInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`timeout_seconds must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function crossSessionDeliveryRequestId(envelopeId: string): string {
  return `cross_session_${envelopeId}`;
}

function crossSessionDispatchContent(envelope: CrossSessionMessageEnvelope): string {
  return [
    `[[TETHOQ_REMOTE_MESSAGE_V1:${envelope.id}]]`,
    `This message was sent by another Tethoq task: ${envelope.sourceTitle} (${envelope.sourceSessionId}).`,
    "Treat the text below as that task's message. Do not repeat this routing envelope in your response.",
    "",
    envelope.content,
  ].join("\n");
}

function crossSessionMarkerId(content: string): string | undefined {
  return /^\[\[TETHOQ_REMOTE_MESSAGE_V1:([a-zA-Z0-9_-]{1,128})\]\]\n/u.exec(content)?.[1];
}

function isCrossSessionDeliveryMessage(message: RemoteMessage, envelope: CrossSessionMessageEnvelope): boolean {
  if (message.role !== "user") return false;
  const deliveryRequestId = crossSessionDeliveryRequestId(envelope.id);
  if (message.providerMessageId === deliveryRequestId || message.id === deliveryRequestId) return true;
  if (message.nativeMetadata.tethoqEnvelopeId === envelope.id
    || message.nativeMetadata.clientUserMessageId === deliveryRequestId
    || message.nativeMetadata.requestId === deliveryRequestId) return true;
  return message.parts.some((part) => part.type === "text" && crossSessionMarkerId(part.text) === envelope.id);
}

function sameCrossSessionEnvelope(left: CrossSessionMessageEnvelope, right: CrossSessionMessageEnvelope): boolean {
  return left.version === right.version
    && left.id === right.id
    && left.requestId === right.requestId
    && left.sourceSessionId === right.sourceSessionId
    && left.sourceTitle === right.sourceTitle
    && left.targetSessionId === right.targetSessionId
    && left.content === right.content
    && left.createdAt === right.createdAt;
}

function clearDelegationError(task: DelegationTask): DelegationTask {
  const copy = { ...task };
  delete copy.error;
  return copy;
}

/**
 * Framing only, never the request itself. This rides as developer guidance beside the
 * instruction rather than being pasted in front of it: prepending it made the operator's
 * own words the tail of a long briefing, so a one-word message read as a mandate to go
 * and work. The prompt stays the whole visible message, and the worker is told plainly
 * that its scope is whatever that message asks for and nothing more.
 */
function delegatedWorkerInstruction(parent: RemoteSession, displayName: string): string {
  return [
    `You are a ${displayName} worker delegated by another coding-agent session.`,
    `The user's message is the task. Match its scope exactly: answer a small or casual message briefly and stop, and do substantial work only when the message actually asks for it. Never expand a short message into a large autonomous effort.`,
    "Work independently in the same project and return a concise, self-contained result the parent agent can consume.",
    "Do not wait for, message, or attempt to spawn the parent. If you cannot complete something, state the exact blocker.",
    `Parent task, for background only: ${parent.title}`,
  ].join("\n");
}

const foreignSubagentMarker = "[[TETHOQ_FOREIGN_SUBAGENTS_V1]]";

/**
 * Capability guidance for sessions the desktop has allowed to spawn subagents
 * on a different coding tool. It rides as developer instructions so it never
 * appears in the visible transcript, and the marker line stops retried queue
 * deliveries from stacking the same guidance twice.
 */
function foreignSubagentInstruction(): string {
  return [
    foreignSubagentMarker,
    "This Tethoq session is allowed to delegate work to subagents that run on a different coding tool (harness) than your own.",
    'To find a candidate task on another tool, call mesh_list_sessions with an optional "query" search string and a "limit" from 1 to 25; it returns tasks with their stable session IDs and harness names.',
    'To send a subagent request to that task, call mesh_message_session with "target_session_id" (a session ID from mesh_list_sessions), "message" (the work request), and "request_id" (a stable unique ID for this send; reuse it only when retrying the same target and message). The other task receives the request through its own inbox after its user-authored work.',
    'Manage existing delegated child sessions with mesh_list_children, mesh_message_child ("child_session_id", "message"), mesh_wait ("child_session_ids", "timeout_seconds"), and mesh_read_result ("child_session_id").',
    "This capability is per session. When it is off for a session you must not spawn or message foreign subagents with these tools; say plainly that cross-tool subagents are disabled for this task instead of working around the restriction.",
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

function withSimplifyResponseGuidance<T extends SendMessageRequest>(request: T): T {
  const parsed = parseSimplifyCommand(request.content);
  const rawSettings = request.metadata?.simplify;
  const explicit = typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings)
    && (rawSettings.target === "previous" || rawSettings.target === "upcoming")
      ? rawSettings.target
      : undefined;
  if (!parsed.active && explicit === undefined) return request;
  const settings = normalizeSimplifySettings(request.metadata?.simplify);
  const simplifyInstructions = simplifyDeveloperInstructions(settings, explicit ?? parsed.target);
  const metadata = { ...(request.metadata ?? {}) };
  delete metadata.simplify;
  return {
    ...request,
    content: parsed.active ? parsed.content : request.content,
    developerInstructions: request.developerInstructions === undefined
      ? simplifyInstructions
      : `${request.developerInstructions}\n\n${simplifyInstructions}`,
    ...(Object.keys(metadata).length > 0 ? { metadata } : { metadata: undefined }),
  };
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

function isAmbiguousQueueSelection(value: string): boolean {
  return ["", "auto", "default", "cli default", "session default"].includes(value.trim().toLowerCase());
}

function modelReasoningEfforts(model: RemoteModel): readonly string[] {
  const metadata = model.nativeMetadata;
  const source = metadata.supportedReasoningEfforts ?? metadata.reasoningEfforts ?? metadata.supported_reasoning_efforts;
  if (!Array.isArray(source)) return [];
  return [...new Set(source.flatMap((entry) => {
    if (typeof entry === "string") return isAmbiguousQueueSelection(entry) ? [] : [entry.trim()];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as JsonObject;
    const value = typeof record.reasoningEffort === "string"
      ? record.reasoningEffort
      : typeof record.id === "string"
        ? record.id
        : undefined;
    return value === undefined || isAmbiguousQueueSelection(value) ? [] : [value.trim()];
  }))];
}
