import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../../../agent_bridge/src/bridge.js";
import type { BridgeConfig } from "../../../agent_bridge/src/config.js";
import { DelegationStateStore, defaultDelegationStatePath } from "../../../agent_bridge/src/delegation_store.js";
import { SessionTransferStateStore, defaultSessionTransferStatePath } from "../../../agent_bridge/src/session_transfer_store.js";
import { CrossSessionInboxStore, defaultCrossSessionInboxStatePath } from "../../../agent_bridge/src/cross_session_store.js";
import { SessionSelectionStore, defaultSessionSelectionStatePath } from "../../../agent_bridge/src/session_selection_store.js";
import { SessionCatalogueStore, defaultSessionCatalogueStatePath } from "../../../agent_bridge/src/session_catalogue_store.js";
import { EarsHelperStore, defaultEarsHelperStatePath } from "../../../agent_bridge/src/ears_helper_store.js";
import { VisionProxyStore, defaultVisionProxyStatePath } from "../../../agent_bridge/src/vision_proxy_store.js";
import { CompactionThresholdStore, defaultCompactionThresholdStatePath } from "../../../agent_bridge/src/compaction_threshold_store.js";
import { GoalStore, defaultGoalStatePath } from "../../../agent_bridge/src/goal_store.js";
import { QueueDeliveryStore, defaultQueueDeliveryStatePath } from "../../../agent_bridge/src/queue_delivery_store.js";
import { ScheduledTaskStore, defaultScheduledTaskStatePath } from "../../../agent_bridge/src/scheduled_task_store.js";
import { ScheduledTaskScheduler } from "../../../agent_bridge/src/scheduled_tasks.js";
import { recordStartupProfile, startStartupProfileHeartbeat } from "../../../agent_bridge/src/startup_profile.js";
import { PairingStateStore, defaultPairingStatePath } from "../../../agent_bridge/src/pairing_store.js";
import { BridgeRequestRouter } from "../../../agent_bridge/src/request_router.js";
import { defaultMeshRuntimePath, MeshToolGateway, meshToolDefinitions } from "../../../agent_bridge/src/mesh_tools.js";
import { tethoqEnvironmentValue } from "../../../agent_bridge/src/environment.js";
import { defaultTranscriptionSourceRegistry } from "../../../agent_bridge/src/dictation.js";
import { DictationCredentialStore, defaultDictationCredentialStatePath } from "../../../agent_bridge/src/dictation_credentials.js";
import { installOpenCodeMeshTools } from "../../../agent_bridge/src/opencode_tools.js";
import { installPiTools, piToolExtensionPath } from "../../../agent_bridge/src/pi_tools.js";
import { CodexAdapter } from "../../../../packages/provider_codex/src/codex_adapter.js";
import { createPublicAcpProviderAdapter, GrokProviderAdapter, type PublicAcpProviderId } from "../../../../packages/provider_grok/src/grok_adapter.js";
import { OpenCodeAdapter } from "../../../../packages/provider_opencode/src/opencode_adapter.js";
import { PiRpcProviderAdapter, piHarnessPresets } from "../../../../packages/provider_pi/src/pi_rpc_adapter.js";
import { DirectApiProviderAdapter } from "../../../../packages/provider_direct/src/direct_api_adapter.js";
import type { AgentEvent, JsonObject, RequestEnvelope, ResponseEnvelope } from "../../../../packages/protocol/src/index.js";
import { DESKTOP_PROVIDERS, type ConnectorAction, type ConnectorActionResult, type DesktopConnectorState, type DesktopEventBatch, type DesktopRuntimeState } from "../shared/desktop_api.js";
import { isOpenCodePortInUseStatus, OpenCodeSupervisor, resolveAvailableOpenCodeServerUrl } from "./opencode_supervisor.js";
import { discoverOpenCodeServerUrl, ensureOpenCodeFallbackCycle, isOpenCodeServerHealthy, resolveOpenCodeEndpoint, shouldDiscoverOpenCodeServer, DEFAULT_OPENCODE_URL } from "./opencode_discovery.js";
import { OpenCodeWatchdog } from "./opencode_watch.js";
import { approveDesktopConnector, fingerprintInstalledDesktopConnector, loadDesktopConnectors, revokeDesktopConnector, type DesktopConnectorRegistryResult } from "./connectors.js";
import { BrowserAgentTools, browserToolDefinitions } from "./browser_agent_tools.js";
import { installProviderToolHelpers, type ProviderToolSetupIssue } from "./provider_tool_setup.js";
import type { BrowserWorkspaceManager } from "./browser_workspace.js";

// Appended events already flush immediately through subscribeEventAppended().
// This timer is only a recovery heartbeat, so waking the Electron main process
// ten times a second while the window is visible adds cost without lowering
// delivery latency.
const ACTIVE_EVENT_POLL_MS = 1_000;
const HIDDEN_EVENT_POLL_MS = 1_000;
const MAX_EVENT_BATCH = 200;
const OPENCODE_RELIST_MS = 15_000;

export interface DesktopRuntimeOptions {
  readonly config: BridgeConfig;
  readonly configPath: string;
  readonly onEvents: (batch: DesktopEventBatch) => void;
  readonly onState: (state: DesktopRuntimeState) => void;
  readonly connectorsDirectory: string;
  readonly connectorTrustStorePath: string;
  readonly appVersion: string;
  readonly providerAssetsDirectory: string;
  readonly defaultWorkingDirectory: string;
  readonly browserWorkspace: BrowserWorkspaceManager;
  readonly globalAgentInstructions?: () => Promise<string | undefined>;
}

export class DesktopRuntime {
  readonly #config: BridgeConfig;
  readonly #configPath: string;
  readonly #onEvents: (batch: DesktopEventBatch) => void;
  readonly #onState: (state: DesktopRuntimeState) => void;
  readonly #connectorsDirectory: string;
  readonly #connectorTrustStorePath: string;
  readonly #appVersion: string;
  readonly #providerAssetsDirectory: string;
  readonly #defaultWorkingDirectory: string;
  readonly #meshRuntimePath: string;
  #openCode: OpenCodeSupervisor;
  /**
   * True while the supervisor points at a server the desktop discovered (the
   * user's own opencode) rather than one it started itself. Drives re-discovery
   * when that server moves or disappears.
   */
  #openCodeAdopted = false;
  /**
   * Our own managed server kept alive as the provider's secondary feed while a
   * turn it started is still in flight after the desktop handed over to the
   * user's server. Stopped by the retirement tick once the feed drains.
   */
  #retiredOpenCode: OpenCodeSupervisor | undefined;
  readonly #browserWorkspace: BrowserWorkspaceManager;
  readonly #globalAgentInstructions: (() => Promise<string | undefined>) | undefined;
  #openCodeWatchdog: OpenCodeWatchdog | undefined;
  #bridge: AgentBridge | undefined;
  #router: BridgeRequestRouter | undefined;
  #pairingStore: PairingStateStore | undefined;
  #delegationStore: DelegationStateStore | undefined;
  #sessionTransferStore: SessionTransferStateStore | undefined;
  #crossSessionStore: CrossSessionInboxStore | undefined;
  #sessionSelectionStore: SessionSelectionStore | undefined;
  #sessionCatalogueStore: SessionCatalogueStore | undefined;
  #earsHelperStore: EarsHelperStore | undefined;
  #visionProxyStore: VisionProxyStore | undefined;
  #compactionThresholdStore: CompactionThresholdStore | undefined;
  #goalStore: GoalStore | undefined;
  #queueDeliveryStore: QueueDeliveryStore | undefined;
  #restartPromise: Promise<void> | undefined;
  #openCodeEnsurePromise: Promise<ReturnType<OpenCodeSupervisor["status"]>> | undefined;
  #openCodeReconnectPromise: Promise<void> | undefined;
  #eventTimer: NodeJS.Timeout | undefined;
  #openCodeRelistTimer: NodeJS.Timeout | undefined;
  #unsubscribeEventAppended: (() => void) | undefined;
  #eventFlushQueued = false;
  #windowVisible = true;
  #latestSequence = 0;
  #startPromise: Promise<void> | undefined;
  #disposed = false;
  #providerSetupIssues: ProviderToolSetupIssue[] = [];
  #connectorRegistry: DesktopConnectorRegistryResult | undefined;
  #clientTools: MeshToolGateway | undefined;
  readonly #revokedConnectorIds = new Set<string>();
  readonly #pairingConfirmedListeners = new Set<() => void>();

  public constructor(options: DesktopRuntimeOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#onEvents = options.onEvents;
    this.#onState = options.onState;
    this.#connectorsDirectory = options.connectorsDirectory;
    this.#connectorTrustStorePath = options.connectorTrustStorePath;
    this.#appVersion = options.appVersion;
    this.#providerAssetsDirectory = options.providerAssetsDirectory;
    this.#defaultWorkingDirectory = options.defaultWorkingDirectory;
    this.#meshRuntimePath = defaultMeshRuntimePath(options.config.hostId);
    this.#browserWorkspace = options.browserWorkspace;
    this.#globalAgentInstructions = options.globalAgentInstructions;
    const openCodeUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL");
    this.#openCode = new OpenCodeSupervisor(this.#openCodeSupervisorOptions(openCodeUrl ?? DEFAULT_OPENCODE_URL));
  }

  #openCodeSupervisorOptions(url: string): ConstructorParameters<typeof OpenCodeSupervisor>[0] {
    const openCodeCommand = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_COMMAND");
    const port = new URL(url).port;
    const stateFile = port === "4096"
      ? "opencode-supervisor.json"
      : `opencode-supervisor-${port}.json`;
    return {
      url,
      ...(openCodeCommand !== undefined ? { command: openCodeCommand } : {}),
      statePath: join(dirname(this.#configPath), stateFile),
      environment: { ...process.env, UAR_MESH_RUNTIME: this.#meshRuntimePath },
      hasActiveWork: () => (this.#bridge?.providerActiveSessions("opencode").length ?? 0) > 0,
    };
  }

  #createOpenCodeAdapter(options: { url: string; secondaryBaseUrl?: string; secondaryActiveSessionIds?: readonly string[] }): OpenCodeAdapter {
    const workingDirectory = tethoqEnvironmentValue(process.env, "TETHOQ_PROJECT_DIRECTORY");
    const openCodeUsername = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_USERNAME")
      ?? (typeof process.env.OPENCODE_SERVER_USERNAME === "string" && process.env.OPENCODE_SERVER_USERNAME.trim()
        ? process.env.OPENCODE_SERVER_USERNAME
        : undefined);
    const openCodePassword = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_PASSWORD")
      ?? (typeof process.env.OPENCODE_SERVER_PASSWORD === "string" && process.env.OPENCODE_SERVER_PASSWORD
        ? process.env.OPENCODE_SERVER_PASSWORD
        : undefined);
    const openCodeDatabasePath = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_DB_PATH");
    return new OpenCodeAdapter({
      hostId: this.#config.hostId,
      baseUrl: options.url,
      ...(workingDirectory !== undefined ? { directory: workingDirectory } : {}),
      ...(openCodeUsername !== undefined ? { username: openCodeUsername } : {}),
      ...(openCodePassword !== undefined ? { password: openCodePassword } : {}),
      localActivity: openCodeDatabasePath === undefined ? {} : { databasePath: openCodeDatabasePath },
      ...(options.secondaryBaseUrl !== undefined ? { secondaryBaseUrl: options.secondaryBaseUrl } : {}),
      ...(options.secondaryActiveSessionIds !== undefined && options.secondaryActiveSessionIds.length > 0
        ? { secondaryActiveSessionIds: options.secondaryActiveSessionIds }
        : {}),
    });
  }

  public get openCode(): OpenCodeSupervisor {
    return this.#openCode;
  }

  public get providerSetupIssues(): readonly ProviderToolSetupIssue[] {
    return this.#providerSetupIssues;
  }

  public async setupProviderTools(providerId?: string): Promise<void> {
    const tasks = [
      { providerId: "opencode", install: () => installOpenCodeMeshTools({ sourcePath: join(this.#providerAssetsDirectory, "opencode", "uar_mesh.txt") }) },
      { providerId: "pi", install: () => installPiTools({ sourcePath: join(this.#providerAssetsDirectory, "pi", "tethoq_tools.txt") }) },
    ].filter((task) => providerId === undefined || task.providerId === providerId);
    const issues = await installProviderToolHelpers(tasks);
    this.#providerSetupIssues = [...this.#providerSetupIssues.filter((issue) => !tasks.some((task) => task.providerId === issue.providerId)), ...issues];
  }

  public get bridge(): AgentBridge {
    if (this.#bridge === undefined) throw new Error("Tethoq desktop runtime is not ready");
    return this.#bridge;
  }

  public get connectorState(): DesktopConnectorState {
    return this.#connectorRegistry?.state ?? { directory: this.#connectorsDirectory, loaded: [], pending: [], diagnostics: [] };
  }

  /** Lets desktop-owned surfaces react when the bridge accepts a new phone. */
  public onPairingConfirmed(listener: () => void): () => void {
    this.#pairingConfirmedListeners.add(listener);
    return () => this.#pairingConfirmedListeners.delete(listener);
  }

  public allowedProviderIds(): ReadonlySet<string> {
    return new Set((this.#bridge === undefined
      ? [...DESKTOP_PROVIDERS]
      : [...DESKTOP_PROVIDERS, ...(this.#connectorRegistry?.allowedProviderIds ?? [])])
      .filter((providerId) => !this.#revokedConnectorIds.has(providerId)));
  }

  public async start(): Promise<void> {
    if (this.#disposed) throw new Error("Tethoq desktop runtime is closed");
    return this.#startPromise ??= this.startOnce();
  }

  /** Re-check wall-clock schedules after Windows resumes from sleep. */
  public async reconcileScheduledTasks(): Promise<void> {
    await this.start();
    await this.bridge.reconcileScheduledTasks();
  }

  public async request(type: string, payload: JsonObject = {}, requestId = `desktop_${randomUUID()}`): Promise<ResponseEnvelope> {
    await this.start();
    const router = this.#router;
    if (router === undefined) throw new Error("Tethoq desktop request router is unavailable");
    const request: RequestEnvelope = {
      protocolVersion: 1,
      messageId: randomUUID(),
      hostId: this.#config.hostId,
      sentAt: new Date().toISOString(),
      kind: "request",
      type,
      requestId,
      payload,
    };
    return await router.handle(request);
  }

  public async restartOpenCode(): Promise<ReturnType<OpenCodeSupervisor["status"]>> {
    await this.start();
    if (this.#restartPromise !== undefined) {
      await this.#restartPromise;
      return this.#openCode.status();
    }
    this.#restartPromise = (async () => {
      const bridge = this.#bridge;
      if (bridge === undefined) throw new Error("Tethoq desktop runtime is not ready");
      const status = await this.#openCode.restart();
      if (status.state === "managed" || status.state === "external") await this.reconnectOpenCodeProvider(bridge);
    })().finally(() => { this.#restartPromise = undefined; });
    await this.#restartPromise;
    return this.#openCode.status();
  }

  public ensureOpenCode(): Promise<ReturnType<OpenCodeSupervisor["status"]>> {
    const inFlight = this.#openCodeEnsurePromise;
    if (inFlight !== undefined) return inFlight;
    const ensuring = this.ensureOpenCodeOnce().finally(() => {
      if (this.#openCodeEnsurePromise === ensuring) this.#openCodeEnsurePromise = undefined;
    });
    this.#openCodeEnsurePromise = ensuring;
    return ensuring;
  }

  private async ensureOpenCodeOnce(): Promise<ReturnType<OpenCodeSupervisor["status"]>> {
    // The caller routes the single provider.reconnect request after ensuring
    // the HTTP process exists. Reconnecting here as well duplicates provider
    // subscriptions and can race two refreshes from one UI action.
    const envUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL");
    const status = this.#openCode.status();
    if (shouldDiscoverOpenCodeServer({ envUrl, status, hasManagedChild: this.#openCode.hasManagedChild })) {
      const discoveredUrl = await discoverOpenCodeServerUrl();
      const decision = resolveOpenCodeEndpoint({
        envUrl,
        discoveredUrl,
        discoveredHealthy: discoveredUrl === undefined
          ? false
          : await isOpenCodeServerHealthy(discoveredUrl, this.#openCodeSupervisorOptions(discoveredUrl)),
        currentUrl: status.url,
        adopted: this.#openCodeAdopted,
        currentExternal: status.state === "external",
        defaultUrl: DEFAULT_OPENCODE_URL,
      });
      if (decision !== undefined) {
        try {
          await this.#adoptOpenCodeServer(decision.url);
        } catch {
          // The supervisor has already repointed; the provider retries through
          // the bridge's resubscribe loop against the new server.
        }
        this.#openCodeAdopted = decision.adopted;
      }
    }
    await this.#retireOpenCodeIfIdle();
    // Confirm the adopted endpoint once with its real credentials. If an
    // inaccessible sidecar owns 4096, choose a free port in our bounded
    // fallback range and confirm it in this same watchdog cycle rather than
    // trying to bind a second process on the occupied port.
    const failedFallbackPorts = new Set<number>();
    const result = await ensureOpenCodeFallbackCycle({
      envUrl,
      adopted: this.#openCodeAdopted,
      ensureRunning: () => this.#openCode.ensureRunning(),
      switchEndpoint: async (url, failedStatus) => {
        if (isOpenCodePortInUseStatus(failedStatus)) {
          const failedPort = Number(new URL(failedStatus.url).port);
          if (Number.isInteger(failedPort)) failedFallbackPorts.add(failedPort);
        }
        const availableUrl = await resolveAvailableOpenCodeServerUrl(url, { excludedPorts: failedFallbackPorts });
        try {
          await this.#adoptOpenCodeServer(availableUrl);
        } catch {
          // The supervisor is repointed before the provider replacement runs;
          // the bridge's reconnect path owns any provider-side retry.
        }
        this.#openCodeAdopted = false;
        await this.#retireOpenCodeIfIdle();
      },
    });
    this.#openCodeAdopted = result.adopted;
    return result.status;
  }

  private reconnectOpenCodeProvider(bridge: AgentBridge): Promise<void> {
    const inFlight = this.#openCodeReconnectPromise;
    if (inFlight !== undefined) return inFlight;
    const reconnecting = bridge.reconnectProvider("opencode").finally(() => {
      if (this.#openCodeReconnectPromise === reconnecting) this.#openCodeReconnectPromise = undefined;
    });
    this.#openCodeReconnectPromise = reconnecting;
    return reconnecting;
  }

  /**
   * Swaps the supervisor to a different server and repoints the provider.
   * When our own managed server still has a turn in flight, it is kept alive as
   * the adapter's secondary feed instead of being killed under that turn; the
   * retirement tick stops it once the feed drains.
   */
  async #adoptOpenCodeServer(url: string): Promise<void> {
    const old = this.#openCode;
    const childOwner = this.#retiredOpenCode ?? old;
    const activeSessions = await this.#bridge?.providerActiveSessions("opencode") ?? [];
    const keepOurs = childOwner.hasManagedChild
      && childOwner.status().url !== url
      && activeSessions.length > 0;
    const next = new OpenCodeSupervisor(this.#openCodeSupervisorOptions(url));
    if (keepOurs) {
      if (this.#retiredOpenCode === undefined) this.#retiredOpenCode = old;
    } else {
      await old.dispose();
      if (this.#retiredOpenCode !== undefined && childOwner.status().url !== url) {
        await this.#retiredOpenCode.dispose();
        this.#retiredOpenCode = undefined;
      }
    }
    this.#openCode = next;
    await this.#bridge?.replaceProviderAdapter(this.#createOpenCodeAdapter({
      url,
      ...(keepOurs ? {
        secondaryBaseUrl: childOwner.status().url,
        secondaryActiveSessionIds: activeSessions,
      } : {}),
    }));
  }

  /** Stops the previous server once nothing streams through its feed anymore. */
  async #retireOpenCodeIfIdle(): Promise<void> {
    const retired = this.#retiredOpenCode;
    if (retired === undefined) return;
    if (retired.status().url === this.#openCode.status().url) return;
    if (await this.#bridge?.isProviderSecondaryBusy("opencode") === true) return;
    await retired.dispose();
    this.#retiredOpenCode = undefined;
    await this.#bridge?.setProviderSecondaryUrl("opencode", undefined);
  }

  /** Keeps active chat streaming responsive while avoiding a 10 Hz hidden-window poll. */
  public setWindowVisible(visible: boolean): void {
    if (this.#windowVisible === visible) return;
    this.#windowVisible = visible;
    this.scheduleEventPoll();
    if (visible) this.pollEvents();
  }

  public async connectorAction(action: ConnectorAction): Promise<ConnectorActionResult> {
    await this.start();
    const current = this.connectorState;
    if (action.type === "approve") {
      const pending = current.pending.find((connector) => connector.fingerprint === action.fingerprint);
      if (pending === undefined) throw new Error("That connector is not awaiting review");
      const currentFingerprint = await fingerprintInstalledDesktopConnector(pending.directory);
      if (currentFingerprint !== pending.fingerprint) throw new Error("The connector changed during review. Restart Tethoq and review it again.");
      await approveDesktopConnector(this.#connectorTrustStorePath, pending.fingerprint);
      return { connectors: current, restartRequired: true };
    }
    const loaded = current.loaded.find((connector) => connector.fingerprint === action.fingerprint);
    if (loaded === undefined) throw new Error("That connector is not currently enabled");
    await revokeDesktopConnector(this.#connectorTrustStorePath, loaded.fingerprint);
    this.#revokedConnectorIds.add(loaded.id);
    const mutableLoaded = this.#connectorRegistry?.state.loaded;
    if (Array.isArray(mutableLoaded)) {
      const index = mutableLoaded.findIndex((connector) => connector.id === loaded.id);
      if (index >= 0) mutableLoaded.splice(index, 1);
    }
    const adapter = this.#connectorRegistry?.adapters.find((candidate) => candidate.providerId === loaded.id);
    await adapter?.dispose();
    const connectors: DesktopConnectorState = {
      ...current,
      loaded: current.loaded.filter((connector) => connector.fingerprint !== loaded.fingerprint),
    };
    return { connectors, restartRequired: true };
  }

  public async dispose(options: { readonly preserveOpenCode?: boolean; readonly forceStopOpenCode?: boolean } = {}): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pairingConfirmedListeners.clear();
    this.#onState({ state: "stopping" });
    this.#unsubscribeEventAppended?.();
    this.#unsubscribeEventAppended = undefined;
    clearTimeout(this.#eventTimer);
    this.#eventTimer = undefined;
    clearTimeout(this.#openCodeRelistTimer);
    this.#openCodeRelistTimer = undefined;
    this.#openCodeWatchdog?.dispose();
    this.#openCodeWatchdog = undefined;
    // A due schedule can create and start an OpenCode turn during shutdown.
    // Drain it while both the provider runner and Bridge adapters are alive,
    // then sample activity before either side is released or disposed.
    await this.#bridge?.drainScheduledTasksForShutdown().catch(() => undefined);
    const openCodeHasActiveWork = (this.#bridge?.providerActiveSessions("opencode").length ?? 0) > 0
      || this.#bridge?.isProviderSecondaryBusy("opencode") === true;
    // An application restart is a presentation/runtime handoff, not permission
    // to terminate model work. Preserve the provider runner when the relaunch
    // path says so or when the drained Bridge sees any possibly live turn.
    const preserveOpenCode = options.forceStopOpenCode !== true
      && (options.preserveOpenCode === true || openCodeHasActiveWork);
    await Promise.allSettled([
      this.#bridge?.dispose(),
      this.#clientTools?.close(),
      this.#connectorRegistry?.dispose(),
      preserveOpenCode ? this.#openCode.release() : this.#openCode.dispose(),
      preserveOpenCode ? this.#retiredOpenCode?.release() : this.#retiredOpenCode?.dispose(),
    ]);
    this.#retiredOpenCode = undefined;
    await Promise.allSettled([this.#pairingStore?.flush(), this.#delegationStore?.flush(), this.#sessionTransferStore?.flush(), this.#crossSessionStore?.flush(), this.#sessionSelectionStore?.flush(), this.#sessionCatalogueStore?.flush(), this.#earsHelperStore?.flush(), this.#visionProxyStore?.flush(), this.#compactionThresholdStore?.flush(), this.#goalStore?.flush(), this.#queueDeliveryStore?.flush()]);
  }

  private async startOnce(): Promise<void> {
    const stopStartupHeartbeat = startStartupProfileHeartbeat("desktop-runtime.startOnce");
    const profile = (phase: string, details: Readonly<Record<string, unknown>> = {}) => {
      recordStartupProfile({ type: "runtime-phase", phase, ...details });
    };
    profile("begin");
    this.#onState({ state: "starting" });
    try {
      profile("install-provider-tools.begin");
      await this.setupProviderTools();
      profile("install-provider-tools.end");
      // A replacement generation first reattaches to the healthy runner that
      // the previous Tethoq generation recorded. Only when no retained runner
      // exists may discovery select the user's AI Desktop sidecar or CLI server.
      profile("opencode-probe.begin");
      const openCodeStatus = await this.#openCode.probe();
      profile("opencode-probe.end", { state: openCodeStatus.state, managed: openCodeStatus.managed });
      const envUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL");
      if (shouldDiscoverOpenCodeServer({ envUrl, status: openCodeStatus, hasManagedChild: this.#openCode.hasManagedChild })) {
        profile("opencode-discovery.begin");
        const discoveredUrl = await discoverOpenCodeServerUrl();
        if (discoveredUrl !== undefined && (await isOpenCodeServerHealthy(discoveredUrl, this.#openCodeSupervisorOptions(discoveredUrl)))) {
          await this.#openCode.dispose();
          this.#openCode = new OpenCodeSupervisor(this.#openCodeSupervisorOptions(discoveredUrl));
          this.#openCodeAdopted = true;
          await this.#openCode.probe();
        }
        profile("opencode-discovery.end", { discovered: discoveredUrl !== undefined, adopted: this.#openCodeAdopted });
      }
      const pairingStore = new PairingStateStore(defaultPairingStatePath(this.#configPath));
      const delegationStore = new DelegationStateStore(defaultDelegationStatePath(this.#configPath));
      const sessionTransferStore = new SessionTransferStateStore(defaultSessionTransferStatePath(this.#configPath));
      const crossSessionStore = new CrossSessionInboxStore(defaultCrossSessionInboxStatePath(this.#configPath));
      const sessionSelectionStore = new SessionSelectionStore(defaultSessionSelectionStatePath(this.#configPath));
      const sessionCatalogueStore = new SessionCatalogueStore(defaultSessionCatalogueStatePath(this.#configPath), this.#config.hostId);
      const earsHelperStore = new EarsHelperStore(defaultEarsHelperStatePath(this.#configPath));
      const visionProxyStore = new VisionProxyStore(defaultVisionProxyStatePath(this.#configPath), this.#config.hostId);
      const compactionThresholdStore = new CompactionThresholdStore(defaultCompactionThresholdStatePath(this.#configPath));
      const goalStore = new GoalStore(defaultGoalStatePath(this.#configPath));
      const queueDeliveryStore = new QueueDeliveryStore(defaultQueueDeliveryStatePath(this.#configPath), this.#config.hostId);
      const scheduledTaskStore = new ScheduledTaskStore(defaultScheduledTaskStatePath(this.#configPath));
      const dictationCredentialStore = new DictationCredentialStore(
        defaultDictationCredentialStatePath(this.#configPath),
        this.#config.identity.privateKeyPem,
      );
      this.#pairingStore = pairingStore;
      this.#delegationStore = delegationStore;
      this.#sessionTransferStore = sessionTransferStore;
      this.#crossSessionStore = crossSessionStore;
      this.#sessionSelectionStore = sessionSelectionStore;
      this.#sessionCatalogueStore = sessionCatalogueStore;
      this.#earsHelperStore = earsHelperStore;
      this.#visionProxyStore = visionProxyStore;
      this.#compactionThresholdStore = compactionThresholdStore;
      this.#goalStore = goalStore;
      this.#queueDeliveryStore = queueDeliveryStore;
      profile("state-read.begin");
      const [pairingState, delegationState, sessionTransferState, crossSessionState, dictationCredentials, sessionSelectionState, sessionCatalogue, earsHelperState, visionProxyState, compactionThresholdState, goalState, queueDeliveryState] = await Promise.all([
        pairingStore.read(),
        delegationStore.read(),
        sessionTransferStore.read(),
        crossSessionStore.read(),
        dictationCredentialStore.read(),
        sessionSelectionStore.read(),
        sessionCatalogueStore.read(),
        earsHelperStore.read(),
        visionProxyStore.read(),
        compactionThresholdStore.read(),
        goalStore.read(),
        queueDeliveryStore.read(),
      ]);
      profile("state-read.end", {
        sessionCatalogueCount: sessionCatalogue.length,
        delegationCount: delegationState.tasks.length,
        sessionTransferCount: sessionTransferState.transfers.length,
        crossSessionMessageCount: crossSessionState.messages.length,
      });
      const openCodeUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL") ?? this.#openCode.status().url;
      const configuredWorkingDirectory = tethoqEnvironmentValue(process.env, "TETHOQ_PROJECT_DIRECTORY");
      // Explorer/Start Menu launches may inherit System32 or the installed app
      // folder as process.cwd(). Neither is a truthful user workspace. Electron
      // resolves the user's real Documents directory across installed machines.
      const workingDirectory = configuredWorkingDirectory ?? this.#defaultWorkingDirectory;
      const codexCommand = tethoqEnvironmentValue(process.env, "TETHOQ_CODEX_COMMAND");
      const codexArgs = parseStringArray(tethoqEnvironmentValue(process.env, "TETHOQ_CODEX_ARGS"));
      const grokCommand = tethoqEnvironmentValue(process.env, "TETHOQ_GROK_COMMAND");
      const grokArgs = parseStringArray(tethoqEnvironmentValue(process.env, "TETHOQ_GROK_ARGS"));
      const publicAcpProviderIds: readonly PublicAcpProviderId[] = ["qwen", "goose", "kimi", "hermes", "cline", "copilot"];
      profile("connectors-load.begin");
      const connectorRegistry = await loadDesktopConnectors({
        rootDirectory: this.#connectorsDirectory,
        trustStorePath: this.#connectorTrustStorePath,
        host: {
          id: this.#config.hostId,
          name: this.#config.displayName,
          version: this.#appVersion,
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "unknown",
        },
        workspaceRoots: [workingDirectory],
      });
      profile("connectors-load.end", { connectorCount: connectorRegistry.adapters.length });
      this.#connectorRegistry = connectorRegistry;
      const adapters = [
        new DirectApiProviderAdapter({
          hostId: this.#config.hostId,
          statePath: join(dirname(this.#configPath), "direct-api-wallet.json"),
          encryptionSecret: this.#config.identity.privateKeyPem,
          environment: process.env,
        }),
        new CodexAdapter({
          hostId: this.#config.hostId,
          permissionStatePath: join(dirname(this.#configPath), "codex-task-permissions.json"),
          ...(codexCommand !== undefined ? { command: codexCommand } : {}),
          ...(codexArgs !== undefined ? { commandArgs: codexArgs } : {}),
          localActivity: { retirementStatePath: join(dirname(this.#configPath), "codex-activity-retirements.json") },
          desktopQueue: {},
        }),
        this.#createOpenCodeAdapter({ url: openCodeUrl }),
        new GrokProviderAdapter({
          hostId: this.#config.hostId,
          cwd: workingDirectory,
          ...(grokCommand !== undefined ? { command: grokCommand } : {}),
          ...(grokArgs !== undefined ? { commandArgs: grokArgs } : {}),
        }),
        ...publicAcpProviderIds.map((providerId) => {
          const prefix = providerId.toUpperCase();
          const command = tethoqEnvironmentValue(process.env, `TETHOQ_${prefix}_COMMAND`);
          const commandArgs = parseStringArray(tethoqEnvironmentValue(process.env, `TETHOQ_${prefix}_ARGS`));
          return createPublicAcpProviderAdapter(providerId, {
            hostId: this.#config.hostId,
            cwd: workingDirectory,
            ...(command !== undefined ? { command } : {}),
            ...(commandArgs !== undefined ? { commandArgs } : {}),
          });
        }),
        ...(["pi", "omp"] as const).map((providerId) => {
          const prefix = providerId.toUpperCase();
          const command = tethoqEnvironmentValue(process.env, `TETHOQ_${prefix}_COMMAND`);
          const commandArgs = parseStringArray(tethoqEnvironmentValue(process.env, `TETHOQ_${prefix}_ARGS`));
          return new PiRpcProviderAdapter({
            hostId: this.#config.hostId,
            preset: piHarnessPresets[providerId],
            ...(providerId === "pi" ? { extensionPath: piToolExtensionPath() } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(commandArgs !== undefined ? { commandArgs } : {}),
            environment: { ...process.env, UAR_MESH_RUNTIME: this.#meshRuntimePath },
          });
        }),
        ...connectorRegistry.adapters,
      ];
      profile("adapters-created", { adapterCount: adapters.length });
      const bridge = new AgentBridge(this.#config, adapters, {
        state: pairingState,
        onStateChange: (state) => pairingStore.scheduleWrite(state),
        onPairingConfirmed: () => {
          for (const listener of this.#pairingConfirmedListeners) listener();
        },
        delegations: delegationState.tasks,
        onDelegationsChange: (tasks) => delegationStore.scheduleWrite(tasks),
        sessionTransfers: sessionTransferState.transfers,
        onSessionTransfersChange: (transfers) => sessionTransferStore.scheduleWrite(transfers),
        crossSessionMessages: crossSessionState.messages,
        onCrossSessionMessagesChange: (messages) => crossSessionStore.scheduleWrite(messages),
        queueDeliveries: queueDeliveryState.deliveries,
        onQueueDeliveriesChange: (deliveries) => queueDeliveryStore.scheduleWrite(deliveries),
        sessionSelections: sessionSelectionState.selections,
        onSessionSelectionsChange: (selections) => sessionSelectionStore.scheduleWrite(selections),
        sessionCatalogue,
        onSessionCatalogueChange: (sessions) => sessionCatalogueStore.scheduleWrite(sessions),
        earsHelpers: earsHelperState.helpers,
        onEarsHelpersChange: (helpers) => earsHelperStore.scheduleWrite(helpers),
        visionProxies: visionProxyState.proxies,
        visionHelperSessionIds: visionProxyState.helperSessionIds,
        onVisionProxiesChange: (proxies, helperSessionIds) => visionProxyStore.scheduleWrite(proxies, helperSessionIds),
        compactionThresholds: compactionThresholdState.thresholds,
        onCompactionThresholdsChange: (thresholds) => compactionThresholdStore.write(thresholds),
        goals: goalState.goals,
        onGoalsChange: (goals) => goalStore.write(goals),
        defaultWorkingDirectory: workingDirectory,
        internalHelperWorkingDirectory: dirname(this.#configPath),
        transcriptionSources: defaultTranscriptionSourceRegistry({
          ...(dictationCredentials["openai-stt"] !== undefined ? { openAiApiKey: dictationCredentials["openai-stt"] } : {}),
          ...(dictationCredentials["xai-stt"] !== undefined ? { xAiApiKey: dictationCredentials["xai-stt"] } : {}),
        }),
        onTranscriptionCredentialChange: (sourceId, apiKey) => {
          if (sourceId !== "openai-stt" && sourceId !== "xai-stt") throw new Error("Dictation source is not configurable");
          return dictationCredentialStore.set(sourceId, apiKey);
        },
        ...(this.#globalAgentInstructions !== undefined ? { globalAgentInstructions: this.#globalAgentInstructions } : {}),
      });
      profile("bridge-created");
      const browserTools = new BrowserAgentTools(this.#browserWorkspace, {
        onCapture: async (parentSessionId, capture, question) => {
          const result = await bridge.askVisionProxy(parentSessionId, question, [capture.attachment]);
          return { observation: result.observation };
        },
      });
      const clientTools = new MeshToolGateway(
        this.#config.hostId,
        (parentSessionId, tool, input, context) => tool.startsWith("browser_")
          ? browserTools.execute(parentSessionId, tool, input)
          : bridge.executeClientTool(parentSessionId, tool, input, context),
        {
          definitions: [...meshToolDefinitions, ...browserToolDefinitions],
          runtimePath: this.#meshRuntimePath,
          mcpScript: fileURLToPath(new URL("./mesh_mcp_stdio.js", import.meta.url)),
        },
      );
      profile("client-tools-listen.begin");
      await clientTools.listen();
      profile("client-tools-listen.end");
      bridge.configureClientTooling(clientTools);
      this.#clientTools = clientTools;
      this.#bridge = bridge;
      bridge.configureScheduledTasks(await ScheduledTaskScheduler.open({
        store: scheduledTaskStore,
        dispatch: async (task) => await bridge.dispatchScheduledTask(task),
        onChange: async ({ reason, task, previousTargetSessionId }) =>
          bridge.scheduledTaskChanged(task, reason, previousTargetSessionId),
        onError: (error) => console.error("Scheduled task reconciliation failed", error),
      }));
      this.#router = new BridgeRequestRouter(bridge);
      profile("bridge-start.begin");
      await bridge.start();
      profile("bridge-start.end");
      this.#latestSequence = 0;
      this.#unsubscribeEventAppended = bridge.subscribeEventAppended(() => this.queueEventFlush());
      this.scheduleEventPoll();
      this.#onState({ state: "ready" });
      profile("ready");
      this.startOpenCodeInBackground(bridge);
      this.startOpenCodeWatchdog(bridge);
      this.scheduleOpenCodeRelist();
    } catch (error) {
      clearTimeout(this.#eventTimer);
      this.#eventTimer = undefined;
      await Promise.allSettled([
        this.#bridge?.dispose(),
        this.#clientTools?.close(),
        this.#connectorRegistry?.dispose(),
        this.#openCode.dispose(),
      ]);
      this.#bridge = undefined;
      this.#router = undefined;
      this.#clientTools = undefined;
      this.#connectorRegistry = undefined;
      const message = error instanceof Error ? error.message : String(error);
      profile("failed", { message });
      this.#onState({ state: "failed", message });
      throw error;
    } finally {
      stopStartupHeartbeat();
    }
  }

  /**
   * OpenCode sessions only exist while `opencode serve` is up, so the desktop owns
   * that process for its whole lifetime — started here, re-checked by the watchdog
   * every interval, and stopped by dispose(). It runs after the runtime reports
   * ready because a cold server can take seconds to answer its health check, and
   * blocking on that would hold the whole app on its splash screen.
   */
  private startOpenCodeInBackground(bridge: AgentBridge): void {
    void (async () => {
      try {
        const status = await this.ensureOpenCode();
        if (this.#disposed || this.#bridge !== bridge) return;
        // "external" counts too: a server we did not start (a previous desktop
        // left one behind, or the user runs their own) can still have come up
        // after the startup refresh already wrote OpenCode off as unavailable.
        if (status.state === "managed" || status.state === "external") await this.reconnectOpenCodeProvider(bridge);
      } catch {
        // A missing or failing OpenCode install is reported through the
        // supervisor status; the rest of the desktop stays usable without it.
      }
    })();
  }

  /**
   * A server that dies after startup must not stay dead for the rest of the app
   * session. The watchdog probes on a calm cadence, restarts a missing server,
   * and reconnects the bridge whenever OpenCode enters a running state that
   * differs from the last one observed — including a killed external server the
   * desktop replaces with its own. It steps aside while the user's own restart
   * is stopping the process.
   */
  private startOpenCodeWatchdog(bridge: AgentBridge): void {
    this.#openCodeWatchdog?.dispose();
    this.#openCodeWatchdog = new OpenCodeWatchdog({
      // Discovery is part of supervision, not only startup. OpenCode AI
      // Desktop can appear after Tethoq or restart its sidecar on a new port;
      // only that owning server carries the live reasoning deltas.
      ensureRunning: () => this.ensureOpenCode(),
      reconnect: () => this.reconnectOpenCodeProvider(bridge),
      connected: () => bridge.isProviderConnected("opencode"),
      stopping: () => this.#openCode.isStopping,
    });
    this.#openCodeWatchdog.start();
  }

  private queueEventFlush(): void {
    if (this.#eventFlushQueued || this.#disposed) return;
    this.#eventFlushQueued = true;
    setImmediate(() => {
      this.#eventFlushQueued = false;
      this.pollEvents();
    });
  }

  private pollEvents(): void {
    const bridge = this.#bridge;
    if (bridge === undefined || this.#disposed) return;
    const replay = bridge.eventReplaySince(this.#latestSequence);
    if (replay.events.length === 0 && !replay.replayGap) return;
    const events: readonly AgentEvent[] = replay.events.slice(0, MAX_EVENT_BATCH);
    const through = events.at(-1)?.sequence ?? replay.latestSequence;
    this.#latestSequence = through;
    this.#onEvents({ events, latestSequence: through, replayGap: replay.replayGap });
    // A burst can exceed one bounded IPC batch. Drain the rest on the next
    // event-loop turn instead of leaving its final text/status on the heartbeat.
    if (replay.events.length > events.length) this.queueEventFlush();
  }

  private scheduleEventPoll(): void {
    clearTimeout(this.#eventTimer);
    this.#eventTimer = undefined;
    if (this.#disposed || this.#bridge === undefined) return;
    const delay = this.#windowVisible ? ACTIVE_EVENT_POLL_MS : HIDDEN_EVENT_POLL_MS;
    this.#eventTimer = setTimeout(() => {
      this.#eventTimer = undefined;
      this.pollEvents();
      this.scheduleEventPoll();
    }, delay);
    this.#eventTimer.unref();
  }

  /**
   * The event feed is the fast path for session lists, and a full refresh
   * touches every provider (spawning idle processes the doctrine forbids).
   * OpenCode is the exception: its HTTP list is cheap and the desktop owns the
   * server, so re-listing it on a calm cadence keeps titles, previews, recency,
   * and working state fresh in the bridge cache even while the live feed is
   * quiet — which is what lets the task list update itself without a click.
   */
  private scheduleOpenCodeRelist(): void {
    clearTimeout(this.#openCodeRelistTimer);
    this.#openCodeRelistTimer = undefined;
    if (this.#disposed || this.#bridge === undefined) return;
    this.#openCodeRelistTimer = setTimeout(() => {
      this.#openCodeRelistTimer = undefined;
      // reconnectProvider is a no-op for the subscription when it is already
      // live, and it re-lists the provider afterwards, which is what keeps the
      // cached session list fresh.
      const bridge = this.#bridge;
      if (bridge !== undefined) void this.reconnectOpenCodeProvider(bridge).catch(() => undefined);
      this.scheduleOpenCodeRelist();
    }, OPENCODE_RELIST_MS);
    this.#openCodeRelistTimer.unref();
  }
}

export function parseStringArray(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("Provider argument environment variables must be JSON string arrays");
  return parsed;
}
