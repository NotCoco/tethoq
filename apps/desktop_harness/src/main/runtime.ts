import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../../../agent_bridge/src/bridge.js";
import type { BridgeConfig } from "../../../agent_bridge/src/config.js";
import { DelegationStateStore, defaultDelegationStatePath } from "../../../agent_bridge/src/delegation_store.js";
import { SessionTransferStateStore, defaultSessionTransferStatePath } from "../../../agent_bridge/src/session_transfer_store.js";
import { PairingStateStore, defaultPairingStatePath } from "../../../agent_bridge/src/pairing_store.js";
import { BridgeRequestRouter } from "../../../agent_bridge/src/request_router.js";
import { defaultMeshRuntimePath, MeshToolGateway, meshToolDefinitions } from "../../../agent_bridge/src/mesh_tools.js";
import { tethoqEnvironmentFlag, tethoqEnvironmentValue } from "../../../agent_bridge/src/environment.js";
import { installOpenCodeMeshTools } from "../../../agent_bridge/src/opencode_tools.js";
import { installPiTools, piToolExtensionPath } from "../../../agent_bridge/src/pi_tools.js";
import { CodexAdapter } from "../../../../packages/provider_codex/src/codex_adapter.js";
import { createPublicAcpProviderAdapter, GrokProviderAdapter, type PublicAcpProviderId } from "../../../../packages/provider_grok/src/grok_adapter.js";
import { OpenCodeAdapter } from "../../../../packages/provider_opencode/src/opencode_adapter.js";
import { PiRpcProviderAdapter, piHarnessPresets } from "../../../../packages/provider_pi/src/pi_rpc_adapter.js";
import { DirectApiProviderAdapter } from "../../../../packages/provider_direct/src/direct_api_adapter.js";
import type { AgentEvent, JsonObject, RequestEnvelope, ResponseEnvelope } from "../../../../packages/protocol/src/index.js";
import { DESKTOP_PROVIDERS, type ConnectorAction, type ConnectorActionResult, type DesktopConnectorState, type DesktopEventBatch, type DesktopRuntimeState } from "../shared/desktop_api.js";
import { OpenCodeSupervisor } from "./opencode_supervisor.js";
import { approveDesktopConnector, fingerprintInstalledDesktopConnector, loadDesktopConnectors, revokeDesktopConnector, type DesktopConnectorRegistryResult } from "./connectors.js";
import { BrowserAgentTools, browserToolDefinitions } from "./browser_agent_tools.js";
import type { BrowserWorkspaceManager } from "./browser_workspace.js";

const ACTIVE_EVENT_POLL_MS = 100;
const HIDDEN_EVENT_POLL_MS = 1_000;
const MAX_EVENT_BATCH = 200;

export interface DesktopRuntimeOptions {
  readonly config: BridgeConfig;
  readonly configPath: string;
  readonly onEvents: (batch: DesktopEventBatch) => void;
  readonly onState: (state: DesktopRuntimeState) => void;
  readonly connectorsDirectory: string;
  readonly connectorTrustStorePath: string;
  readonly appVersion: string;
  readonly providerAssetsDirectory: string;
  readonly browserWorkspace: BrowserWorkspaceManager;
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
  readonly #meshRuntimePath: string;
  readonly #openCode: OpenCodeSupervisor;
  readonly #browserWorkspace: BrowserWorkspaceManager;
  #bridge: AgentBridge | undefined;
  #router: BridgeRequestRouter | undefined;
  #pairingStore: PairingStateStore | undefined;
  #delegationStore: DelegationStateStore | undefined;
  #sessionTransferStore: SessionTransferStateStore | undefined;
  #restartPromise: Promise<void> | undefined;
  #eventTimer: NodeJS.Timeout | undefined;
  #windowVisible = true;
  #latestSequence = 0;
  #startPromise: Promise<void> | undefined;
  #disposed = false;
  #connectorRegistry: DesktopConnectorRegistryResult | undefined;
  #clientTools: MeshToolGateway | undefined;
  readonly #revokedConnectorIds = new Set<string>();

  public constructor(options: DesktopRuntimeOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#onEvents = options.onEvents;
    this.#onState = options.onState;
    this.#connectorsDirectory = options.connectorsDirectory;
    this.#connectorTrustStorePath = options.connectorTrustStorePath;
    this.#appVersion = options.appVersion;
    this.#providerAssetsDirectory = options.providerAssetsDirectory;
    this.#meshRuntimePath = defaultMeshRuntimePath(options.config.hostId);
    this.#browserWorkspace = options.browserWorkspace;
    const openCodeUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL");
    const openCodeCommand = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_COMMAND");
    this.#openCode = new OpenCodeSupervisor({
      ...(openCodeUrl !== undefined ? { url: openCodeUrl } : {}),
      ...(openCodeCommand !== undefined ? { command: openCodeCommand } : {}),
      environment: { ...process.env, UAR_MESH_RUNTIME: this.#meshRuntimePath },
    });
  }

  public get openCode(): OpenCodeSupervisor {
    return this.#openCode;
  }

  public get bridge(): AgentBridge {
    if (this.#bridge === undefined) throw new Error("Tethoq desktop runtime is not ready");
    return this.#bridge;
  }

  public get connectorState(): DesktopConnectorState {
    return this.#connectorRegistry?.state ?? { directory: this.#connectorsDirectory, loaded: [], pending: [], diagnostics: [] };
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
      if (status.state === "managed" || status.state === "external") await bridge.reconnectProvider("opencode");
    })().finally(() => { this.#restartPromise = undefined; });
    await this.#restartPromise;
    return this.#openCode.status();
  }

  public async ensureOpenCode(): Promise<ReturnType<OpenCodeSupervisor["status"]>> {
    // The caller routes the single provider.reconnect request after ensuring
    // the HTTP process exists. Reconnecting here as well duplicates provider
    // subscriptions and can race two refreshes from one UI action.
    return await this.#openCode.ensureRunning();
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

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onState({ state: "stopping" });
    clearTimeout(this.#eventTimer);
    this.#eventTimer = undefined;
    await Promise.allSettled([this.#bridge?.dispose(), this.#clientTools?.close(), this.#connectorRegistry?.dispose(), this.#openCode.dispose()]);
    await Promise.allSettled([this.#pairingStore?.flush(), this.#delegationStore?.flush(), this.#sessionTransferStore?.flush()]);
  }

  private async startOnce(): Promise<void> {
    this.#onState({ state: "starting" });
    try {
      await installOpenCodeMeshTools({ sourcePath: join(this.#providerAssetsDirectory, "opencode", "uar_mesh.txt") });
      await installPiTools({ sourcePath: join(this.#providerAssetsDirectory, "pi", "tethoq_tools.txt") });
      await this.#openCode.ensureRunning();
      const pairingStore = new PairingStateStore(defaultPairingStatePath(this.#configPath));
      const delegationStore = new DelegationStateStore(defaultDelegationStatePath(this.#configPath));
      const sessionTransferStore = new SessionTransferStateStore(defaultSessionTransferStatePath(this.#configPath));
      this.#pairingStore = pairingStore;
      this.#delegationStore = delegationStore;
      this.#sessionTransferStore = sessionTransferStore;
      const [pairingState, delegationState, sessionTransferState] = await Promise.all([
        pairingStore.read(),
        delegationStore.read(),
        sessionTransferStore.read(),
      ]);
      const openCodeUrl = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_URL") ?? this.#openCode.status().url;
      const configuredWorkingDirectory = tethoqEnvironmentValue(process.env, "TETHOQ_PROJECT_DIRECTORY");
      const workingDirectory = configuredWorkingDirectory ?? process.cwd();
      const codexCommand = tethoqEnvironmentValue(process.env, "TETHOQ_CODEX_COMMAND");
      const codexArgs = parseStringArray(tethoqEnvironmentValue(process.env, "TETHOQ_CODEX_ARGS"));
      const openCodeUsername = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_USERNAME");
      const openCodePassword = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_PASSWORD");
      const openCodeDatabasePath = tethoqEnvironmentValue(process.env, "TETHOQ_OPENCODE_DB_PATH");
      const grokCommand = tethoqEnvironmentValue(process.env, "TETHOQ_GROK_COMMAND");
      const grokArgs = parseStringArray(tethoqEnvironmentValue(process.env, "TETHOQ_GROK_ARGS"));
      const publicAcpProviderIds: readonly PublicAcpProviderId[] = ["qwen", "goose", "kimi", "hermes", "cline", "copilot"];
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
          ...(codexCommand !== undefined ? { command: codexCommand } : {}),
          ...(codexArgs !== undefined ? { commandArgs: codexArgs } : {}),
          ...(tethoqEnvironmentFlag(process.env, "TETHOQ_ENABLE_CODEX_LOCAL_STATE") ? { localActivity: {}, desktopQueue: {} } : {}),
        }),
        new OpenCodeAdapter({
          hostId: this.#config.hostId,
          baseUrl: openCodeUrl,
          ...(configuredWorkingDirectory !== undefined ? { directory: configuredWorkingDirectory } : {}),
          ...(openCodeUsername !== undefined ? { username: openCodeUsername } : {}),
          ...(openCodePassword !== undefined ? { password: openCodePassword } : {}),
          ...(tethoqEnvironmentFlag(process.env, "TETHOQ_ENABLE_OPENCODE_LOCAL_STATE")
            ? { localActivity: openCodeDatabasePath === undefined ? {} : { databasePath: openCodeDatabasePath } }
            : {}),
        }),
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
      const bridge = new AgentBridge(this.#config, adapters, {
        state: pairingState,
        onStateChange: (state) => pairingStore.scheduleWrite(state),
        delegations: delegationState.tasks,
        onDelegationsChange: (tasks) => delegationStore.scheduleWrite(tasks),
        sessionTransfers: sessionTransferState.transfers,
        onSessionTransfersChange: (transfers) => sessionTransferStore.scheduleWrite(transfers),
      });
      const browserTools = new BrowserAgentTools(this.#browserWorkspace, {
        onCapture: async (parentSessionId, capture, question) => {
          const result = await bridge.askVisionProxy(parentSessionId, question, [capture.attachment]);
          return { observation: result.observation, helperSessionId: result.helperSessionId };
        },
      });
      const clientTools = new MeshToolGateway(
        this.#config.hostId,
        (parentSessionId, tool, input) => tool.startsWith("browser_")
          ? browserTools.execute(parentSessionId, tool, input)
          : bridge.executeClientTool(parentSessionId, tool, input),
        {
          definitions: [...meshToolDefinitions, ...browserToolDefinitions],
          runtimePath: this.#meshRuntimePath,
          mcpScript: fileURLToPath(new URL("./mesh_mcp_stdio.js", import.meta.url)),
        },
      );
      await clientTools.listen();
      bridge.configureClientTooling(clientTools);
      this.#clientTools = clientTools;
      this.#bridge = bridge;
      this.#router = new BridgeRequestRouter(bridge);
      await bridge.start();
      this.#latestSequence = 0;
      this.scheduleEventPoll();
      this.#onState({ state: "ready" });
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
      this.#onState({ state: "failed", message });
      throw error;
    }
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
}

export function parseStringArray(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("Provider argument environment variables must be JSON string arrays");
  return parsed;
}
