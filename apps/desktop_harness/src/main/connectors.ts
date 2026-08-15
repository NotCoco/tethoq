import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  ConnectorProcessClient,
  loadConnectorManifest,
  type ConnectorCapabilities,
  type ConnectorEvent,
  type ConnectorHostDescriptor,
  type ConnectorManifestV1,
  type ConnectorMessage,
  type ConnectorModelDescriptor,
  type ConnectorQueuedMessage,
  type ConnectorRpcMethod,
  type ConnectorRpcRequestMap,
  type ConnectorSession,
} from "../../../../packages/connector_sdk/src/index.js";
import { makeGlobalSessionId, type ProviderCapabilities, type RemoteMessage, type RemoteModel, type RemoteSession } from "../../../../packages/protocol/src/index.js";
import {
  ProviderEventHub,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type AuthStatus,
  type CreateSessionOptions,
  type EditMessageRequest,
  type EnqueueProviderMessageRequest,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderQueuedMessage,
  type ProviderUserInputResponse,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../../../packages/provider_contract/src/index.js";
import type { DesktopConnectorDescriptor, DesktopConnectorDiagnostic, DesktopConnectorState, PendingDesktopConnectorDescriptor } from "../shared/desktop_api.js";
import {
  fingerprintDesktopConnectorTree,
  fingerprintDesktopConnectorTreeWithOptions,
  readApprovedDesktopConnectorFingerprints,
  type DesktopConnectorExecutionPlan,
} from "./connector_trust.js";

export { approveDesktopConnector, fingerprintDesktopConnectorTree, fingerprintDesktopConnectorTreeWithOptions, revokeDesktopConnector } from "./connector_trust.js";

const MANIFEST_NAME = "tethoq.connector.json";
const RESERVED_IDS = new Set(["all", "codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONNECTORS = 64;
const MAX_JSON_DEPTH = 64;
const MAX_OUTPUT_ITEMS = 10_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_PER_WINDOW = 2_000;
const EVENT_RATE_WINDOW_MS = 10_000;
const RUNTIME_DIRECTORY_PREFIX = "tethoq-connector-runtime-";
const STALE_RUNTIME_AGE_MS = 24 * 60 * 60 * 1_000;

export interface LoadDesktopConnectorsOptions {
  readonly rootDirectory: string;
  readonly trustStorePath?: string;
  readonly host: ConnectorHostDescriptor;
  readonly workspaceRoots?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}

export interface DesktopConnectorRegistryResult {
  readonly adapters: readonly AgentProviderAdapter[];
  readonly allowedProviderIds: ReadonlySet<string>;
  readonly state: DesktopConnectorState;
  dispose(): Promise<void>;
}

interface LoadedConnector {
  readonly adapter: ExternalConnectorAdapter;
  readonly descriptor: DesktopConnectorDescriptor;
}

interface ResolvedConnectorExecution {
  readonly plan: DesktopConnectorExecutionPlan;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface RuntimeCopy {
  readonly root: string;
  readonly directory: string;
  readonly manifest: ConnectorManifestV1;
  readonly execution: ResolvedConnectorExecution;
}

export async function loadDesktopConnectors(options: LoadDesktopConnectorsOptions): Promise<DesktopConnectorRegistryResult> {
  // A forced reboot or process kill can bypass normal adapter disposal. Only
  // remove old app-owned snapshots; live/recent runtimes remain untouched.
  await cleanupStaleConnectorRuntimeCopies().catch(() => undefined);
  const rootDirectory = resolve(options.rootDirectory);
  await mkdir(rootDirectory, { recursive: true });
  const entries = (await readdir(rootDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_CONNECTORS);
  const diagnostics: DesktopConnectorDiagnostic[] = [];
  const loaded: LoadedConnector[] = [];
  const pending: PendingDesktopConnectorDescriptor[] = [];
  const ids = new Set(RESERVED_IDS);
  let approvedFingerprints: ReadonlySet<string> = new Set<string>();
  if (options.trustStorePath !== undefined) {
    try {
      approvedFingerprints = await readApprovedDesktopConnectorFingerprints(options.trustStorePath);
    } catch (error) {
      diagnostics.push({ directory: options.trustStorePath, state: "rejected", message: `Connector approvals ignored: ${safeDiagnostic(error)}` });
    }
  }

  for (const entry of entries) {
    const connectorDirectory = resolve(rootDirectory, entry.name);
    const manifestPath = resolve(connectorDirectory, MANIFEST_NAME);
    let pendingAdapter: ExternalConnectorAdapter | undefined;
    let runtimeCopy: RuntimeCopy | undefined;
    try {
      const realConnectorDirectory = await realpath(connectorDirectory);
      assertContained(await realpath(rootDirectory), realConnectorDirectory, "installation directory");
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
        throw new Error("Connector manifest must be a regular file no larger than 256 KiB");
      }
      const manifest = await loadConnectorManifest(manifestPath);
      assertAllowedConnectorIdentity(manifest);
      if (ids.has(manifest.id)) throw new Error(`Connector id ${manifest.id} is reserved or duplicated`);
      const sourceExecution = await resolveConnectorExecution(realConnectorDirectory, manifest, false);
      const fingerprint = await fingerprintDesktopConnectorTree(realConnectorDirectory, sourceExecution.plan);
      if (!approvedFingerprints.has(fingerprint)) {
        ids.add(manifest.id);
        pending.push(pendingConnectorDescriptor(manifest, fingerprint, connectorDirectory, sourceExecution));
        continue;
      }
      runtimeCopy = await createVerifiedRuntimeCopy(realConnectorDirectory, fingerprint, sourceExecution.plan);
      const runtimeManifest = runtimeCopy.manifest;
      const runtime = runtimeCopy.execution;
      const runtimeCopyRoot = runtimeCopy.root;
      let startupProtocolError: Error | undefined;
      let adapter: ExternalConnectorAdapter | undefined;
      const client = new ConnectorProcessClient({
        manifest: runtimeManifest,
        command: runtime.command,
        args: runtime.args,
        cwd: runtime.cwd,
        env: runtime.plan.launcher === "node"
          ? connectorHostNodeEnvironment(runtimeManifest, options.environment ?? process.env)
          : buildConnectorEnvironment(runtimeManifest, options.environment ?? process.env),
        host: options.host,
        workspaceRoots: options.workspaceRoots ?? [],
        timeoutMs: 15_000,
        initializeTimeoutMs: 8_000,
        shutdownTimeoutMs: 2_000,
        maxStderrLines: 100,
        onEvent: async ({ subscriptionId, event }) => {
          if (adapter === undefined) throw new Error(`Connector ${runtimeManifest.id} emitted an event before initialization`);
          await adapter.receiveEvent(subscriptionId, event);
        },
        onProtocolError: (error) => { startupProtocolError = error; },
      });
      adapter = new ExternalConnectorAdapter(options.host.id, runtimeManifest, client, async () => {
        await rm(runtimeCopyRoot, { recursive: true, force: true });
      });
      pendingAdapter = adapter;
      // Handshake now. A bad connector is quarantined as a diagnostic and can
      // never enter AgentBridge's authorized adapter registry.
      await adapter.initialize();
      if (startupProtocolError !== undefined) throw startupProtocolError;
      ids.add(runtimeManifest.id);
      const descriptor = connectorDescriptor(runtimeManifest, fingerprint, connectorDirectory);
      loaded.push({ adapter, descriptor });
      diagnostics.push({ directory: connectorDirectory, connectorId: runtimeManifest.id, state: "loaded", message: `${runtimeManifest.name} ${runtimeManifest.version} loaded` });
    } catch (error) {
      await pendingAdapter?.dispose().catch(() => undefined);
      if (pendingAdapter === undefined && runtimeCopy !== undefined) await rm(runtimeCopy.root, { recursive: true, force: true }).catch(() => undefined);
      diagnostics.push({ directory: connectorDirectory, state: "rejected", message: safeDiagnostic(error) });
    }
  }

  const allowedProviderIds = new Set(loaded.map((item) => item.adapter.providerId));
  const activeLoaded = loaded.map((item) => item.descriptor);
  const state: { directory: string; loaded: DesktopConnectorDescriptor[]; pending: PendingDesktopConnectorDescriptor[]; diagnostics: DesktopConnectorDiagnostic[] } = {
    directory: rootDirectory,
    loaded: activeLoaded,
    diagnostics,
    pending,
  };
  for (const item of loaded) {
    item.adapter.onDisposed(() => {
      allowedProviderIds.delete(item.adapter.providerId);
      const index = state.loaded.findIndex((descriptor) => descriptor.id === item.adapter.providerId);
      if (index >= 0) state.loaded.splice(index, 1);
    });
  }
  return {
    adapters: loaded.map((item) => item.adapter),
    allowedProviderIds,
    state,
    dispose: async () => { await Promise.allSettled(loaded.map((item) => item.adapter.dispose())); },
  };
}

export async function fingerprintInstalledDesktopConnector(directory: string): Promise<string> {
  const root = await realpath(resolve(directory));
  const manifestPath = resolve(root, MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Connector manifest must be a regular file no larger than 256 KiB");
  }
  const manifest = await loadConnectorManifest(manifestPath);
  assertAllowedConnectorIdentity(manifest);
  const execution = await resolveConnectorExecution(root, manifest, false);
  return await fingerprintDesktopConnectorTree(root, execution.plan);
}

function pendingConnectorDescriptor(
  manifest: ConnectorManifestV1,
  fingerprint: string,
  directory: string,
  runtime: ResolvedConnectorExecution,
): PendingDesktopConnectorDescriptor {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    fingerprint,
    directory,
    runtime: { command: runtime.command, args: [...runtime.args], cwd: runtime.cwd },
    requestedEnvironmentNames: [...(manifest.runtime.env ?? [])],
    permissions: manifest.permissions,
  };
}

export class ExternalConnectorAdapter implements AgentProviderAdapter {
  public readonly providerId: string;
  public readonly displayName: string;
  readonly #hostId: string;
  readonly #client: ConnectorProcessClient;
  readonly #events = new ProviderEventHub();
  readonly #remoteSubscriptions = new Map<string, string>();
  readonly #manifest: ConnectorManifestV1;
  readonly #cleanup: () => Promise<void>;
  readonly #disposedCallbacks = new Set<() => void>();
  #eventWindowStartedAt = Date.now();
  #eventsInWindow = 0;
  #initialized = false;
  #disposed = false;

  public readonly authenticate?: (request: AuthRequest) => Promise<AuthResult>;
  public readonly listModels?: () => Promise<readonly RemoteModel[]>;
  public readonly steerMessage?: (providerSessionId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  public readonly editMessage?: (providerSessionId: string, request: EditMessageRequest) => Promise<SendMessageResult>;
  public readonly interrupt?: (providerSessionId: string) => Promise<void>;
  public readonly listQueuedMessages?: () => Promise<readonly ProviderQueuedMessage[]>;
  public readonly enqueueQueuedMessage?: (providerSessionId: string, request: EnqueueProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly cancelQueuedMessage?: (providerSessionId: string, messageId: string) => Promise<boolean>;
  public readonly respondToApproval?: (response: ProviderApprovalResponse) => Promise<void>;
  public readonly respondToUserInput?: (response: ProviderUserInputResponse) => Promise<void>;

  public constructor(hostId: string, manifest: ConnectorManifestV1, client: ConnectorProcessClient, cleanup: () => Promise<void> = async () => undefined) {
    this.#hostId = hostId;
    this.#client = client;
    this.#manifest = manifest;
    this.#cleanup = cleanup;
    this.providerId = manifest.id;
    this.displayName = manifest.name;
    if (manifest.capabilities.authentication) this.authenticate = async (request) => await this.authenticateConnector(request);
    if (manifest.capabilities.modelEnumeration) this.listModels = async () => await this.listConnectorModels();
    if (manifest.capabilities.steering) this.steerMessage = async (sessionId, request) => await this.steerConnectorMessage(sessionId, request);
    if (manifest.capabilities.messageEditing) this.editMessage = async (sessionId, request) => await this.editConnectorMessage(sessionId, request);
    if (manifest.capabilities.interrupt) this.interrupt = async (sessionId) => await this.interruptConnector(sessionId);
    if (manifest.capabilities.messageQueue) {
      this.listQueuedMessages = async () => await this.listConnectorQueue();
      this.enqueueQueuedMessage = async (sessionId, request) => await this.enqueueConnectorMessage(sessionId, request);
      this.cancelQueuedMessage = async (sessionId, messageId) => await this.cancelConnectorMessage(sessionId, messageId);
    }
    if (manifest.capabilities.approvals) this.respondToApproval = async (response) => await this.respondConnectorApproval(response);
    if (manifest.capabilities.userInput) this.respondToUserInput = async (response) => await this.respondConnectorUserInput(response);
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    // The client validates protocol, identity, version, and capabilities.
    await this.#client.start();
    this.#initialized = true;
  }

  public async detect(): Promise<ProviderDetection> {
    const result = await this.request("provider.detect", {});
    if (!isRecord(result) || typeof result.available !== "boolean" || !boundedStringArray(result.details, 1_000, 20_000)
      || (result.version !== undefined && !boundedString(result.version, 1, 1_000))
      || (result.executable !== undefined && !boundedString(result.executable, 1, 50_000))) {
      throw new Error(`Connector ${this.providerId} returned invalid detection data`);
    }
    return { providerId: this.providerId, available: result.available, details: [...result.details], ...(result.version !== undefined ? { version: result.version } : {}), ...(result.executable !== undefined ? { executable: result.executable } : {}) };
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const result = await this.request("provider.auth.status", {});
    assertAuthStatus(this.providerId, result);
    return result;
  }

  private async authenticateConnector(request: AuthRequest): Promise<AuthResult> {
    const result = await this.request("provider.auth.start", request);
    if (!isRecord(result) || typeof result.authenticated !== "boolean" || typeof result.pending !== "boolean" || !boundedStringArray(result.details, 1_000, 20_000)) {
      throw new Error(`Connector ${this.providerId} returned invalid authentication data`);
    }
    return result;
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return protocolCapabilities(await this.request("provider.capabilities", {}));
  }

  private async listConnectorModels(): Promise<readonly RemoteModel[]> {
    const models = await this.request("provider.models.list", {});
    if (!Array.isArray(models) || models.length > 500) throw new Error(`Connector ${this.providerId} returned an invalid model list`);
    return models.map((model) => normalizeModel(this.providerId, model));
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const result = await this.request("session.list", {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.sortKey !== undefined ? { sortKey: options.sortKey } : {}),
      ...(options.sortDirection !== undefined ? { sortDirection: options.sortDirection } : {}),
      ...(options.parentProviderSessionId !== undefined ? { parentSessionId: options.parentProviderSessionId } : {}),
    });
    assertSessionListResult(this.providerId, result);
    return { sessions: result.sessions.map((session) => this.normalizeSession(session)), nextCursor: result.nextCursor };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    return this.normalizeSession(await this.request("session.get", { sessionId: providerSessionId }));
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const messages = await this.request("session.messages.list", { sessionId: providerSessionId });
    if (!Array.isArray(messages) || messages.length > MAX_OUTPUT_ITEMS) throw new Error(`Connector ${this.providerId} returned an invalid message list`);
    return messages.map((message) => this.normalizeMessage(providerSessionId, message));
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const session = await this.request("session.create", {
      workingDirectory: options.workingDirectory,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.firstInstruction !== undefined ? { firstInstruction: options.firstInstruction } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    });
    return this.normalizeSession(session);
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    await this.request("session.resume", { sessionId: providerSessionId });
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return sendResult(this.providerId, await this.request("session.message.send", messageParams(providerSessionId, request)));
  }

  private async steerConnectorMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return sendResult(this.providerId, await this.request("session.message.steer", messageParams(providerSessionId, request)));
  }

  private async editConnectorMessage(providerSessionId: string, request: EditMessageRequest): Promise<SendMessageResult> {
    return sendResult(this.providerId, await this.request("session.message.edit", {
      ...messageParams(providerSessionId, request),
      messageId: request.providerMessageId,
    }));
  }

  private async interruptConnector(providerSessionId: string): Promise<void> {
    await this.request("session.interrupt", { sessionId: providerSessionId });
  }

  private async listConnectorQueue(): Promise<readonly ProviderQueuedMessage[]> {
    // Queue lists are provider-wide in AgentBridge. The public connector
    // protocol also accepts a sessionId when a host needs a filtered view.
    const messages = await this.request("session.queue.list", {});
    if (!Array.isArray(messages) || messages.length > MAX_OUTPUT_ITEMS) throw new Error(`Connector ${this.providerId} returned an invalid queue`);
    return messages.map((message) => normalizeQueueMessage(this.providerId, message));
  }

  private async enqueueConnectorMessage(providerSessionId: string, request: EnqueueProviderMessageRequest): Promise<ProviderQueuedMessage> {
    return normalizeQueueMessage(this.providerId, await this.request("session.queue.enqueue", { ...messageParams(providerSessionId, request), workingDirectory: request.workingDirectory }));
  }

  private async cancelConnectorMessage(providerSessionId: string, messageId: string): Promise<boolean> {
    return (await this.request("session.queue.cancel", { sessionId: providerSessionId, messageId })).cancelled;
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    const local = this.#events.subscribe(providerSessionId, sink);
    const remote = await this.request("events.subscribe", { sessionId: providerSessionId });
    this.#remoteSubscriptions.set(local.id, remote.subscriptionId);
    return {
      id: local.id,
      unsubscribe: async () => {
        await local.unsubscribe();
        const subscriptionId = this.#remoteSubscriptions.get(local.id);
        this.#remoteSubscriptions.delete(local.id);
        if (subscriptionId !== undefined && !this.#disposed) await this.request("events.unsubscribe", { subscriptionId }).catch(() => undefined);
      },
    };
  }

  private async respondConnectorApproval(response: ProviderApprovalResponse): Promise<void> {
    await this.request("approval.respond", { requestId: response.providerRequestId, choiceId: response.choiceId });
  }

  private async respondConnectorUserInput(response: ProviderUserInputResponse): Promise<void> {
    await this.request("userInput.respond", { requestId: response.providerRequestId, answers: response.answers });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const callback of this.#disposedCallbacks) callback();
    this.#disposedCallbacks.clear();
    this.#events.clear();
    this.#remoteSubscriptions.clear();
    try {
      await this.#client.shutdown();
    } finally {
      await this.#cleanup();
    }
  }

  public onDisposed(callback: () => void): void {
    if (this.#disposed) callback();
    else this.#disposedCallbacks.add(callback);
  }

  private async request<M extends ConnectorRpcMethod>(method: M, params: ConnectorRpcRequestMap[M]["params"]): Promise<ConnectorRpcRequestMap[M]["result"]> {
    if (this.#disposed) throw new Error(`Connector ${this.providerId} is closed`);
    return await this.#client.request(method, params);
  }

  private normalizeSession(session: ConnectorSession): RemoteSession {
    assertConnectorSession(session);
    return {
      id: makeGlobalSessionId(this.#hostId, this.providerId, session.id),
      hostId: this.#hostId,
      providerId: this.providerId,
      providerSessionId: session.id,
      title: session.title,
      ...(session.project !== undefined ? { project: session.project } : {}),
      ...(session.workingDirectory !== undefined ? { workingDirectory: session.workingDirectory } : {}),
      state: session.state,
      ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
      lastActivityAt: session.lastActivityAt,
      ...(session.preview !== undefined ? { preview: session.preview } : {}),
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.parentSessionId !== undefined ? { parentSessionId: makeGlobalSessionId(this.#hostId, this.providerId, session.parentSessionId) } : {}),
      needsApproval: session.needsApproval,
      stale: session.state === "disconnected",
      nativeMetadata: session.metadata ?? {},
    };
  }

  private normalizeMessage(providerSessionId: string, message: ConnectorMessage): RemoteMessage {
    assertConnectorMessage(this.providerId, message);
    if (message.sessionId !== providerSessionId) throw new Error(`Connector ${this.providerId} returned a message for another session`);
    return {
      id: `${encodeURIComponent(this.providerId)}/${encodeURIComponent(message.id)}`,
      sessionId: makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId),
      providerMessageId: message.id,
      role: message.role,
      createdAt: message.createdAt,
      ...(message.completedAt !== undefined ? { completedAt: message.completedAt } : {}),
      parts: message.parts,
      status: message.status,
      ...(message.editable !== undefined ? { editable: message.editable } : {}),
      nativeMetadata: message.metadata ?? {},
    };
  }

  public async receiveEvent(subscriptionId: string, event: ConnectorEvent): Promise<void> {
    if (![...this.#remoteSubscriptions.values()].includes(subscriptionId)) throw new Error(`Connector ${this.providerId} emitted to an unknown subscription`);
    this.enforceEventRate();
    assertConnectorEvent(this.providerId, event, this.#manifest.capabilities);
    try {
      await this.#events.emit(normalizeEvent(this.providerId, event));
    } catch {
      // Consumer failures stay isolated from the connector protocol.
    }
  }

  private enforceEventRate(): void {
    const now = Date.now();
    if (now - this.#eventWindowStartedAt >= EVENT_RATE_WINDOW_MS) {
      this.#eventWindowStartedAt = now;
      this.#eventsInWindow = 0;
    }
    this.#eventsInWindow += 1;
    if (this.#eventsInWindow > MAX_EVENTS_PER_WINDOW) throw new Error(`Connector ${this.providerId} exceeded the event rate limit`);
  }
}

export function buildConnectorEnvironment(manifest: ConnectorManifestV1, source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const windowsEnvironment = process.platform === "win32" || Object.keys(source).some((name) => name.toLowerCase() === "systemroot");
  const sourceNames = windowsEnvironment
    ? new Map(Object.keys(source).map((name) => [name.toLowerCase(), name]))
    : undefined;
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", ...(manifest.runtime.env ?? [])]) {
    const sourceName = sourceNames?.get(name.toLowerCase()) ?? name;
    const value = source[sourceName];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

export function connectorHostNodeEnvironment(
  manifest: ConnectorManifestV1,
  source: NodeJS.ProcessEnv = process.env,
  electronVersion: string | undefined = process.versions.electron,
): Readonly<Record<string, string>> {
  const output = { ...buildConnectorEnvironment(manifest, source) };
  // In the packaged desktop process, process.execPath is Electron itself. This
  // host-owned flag makes the exact same binary act as the bundled Node runtime
  // without trusting a PATH lookup or exposing the flag as connector input.
  if (electronVersion !== undefined) output.ELECTRON_RUN_AS_NODE = "1";
  else delete output.ELECTRON_RUN_AS_NODE;
  return output;
}

async function resolveConnectorExecution(connectorDirectory: string, manifest: ConnectorManifestV1, requireFiles: boolean): Promise<ResolvedConnectorExecution> {
  const root = await realpath(connectorDirectory);
  const cwdRelative = connectorRelativePath(root, manifest.runtime.cwd ?? ".", "runtime working directory", true);
  const unresolvedCwd = resolve(root, cwdRelative);
  let cwd = unresolvedCwd;
  if (requireFiles) {
    cwd = await realpath(unresolvedCwd);
    assertContained(root, cwd, "runtime working directory");
    if (!(await lstat(cwd)).isDirectory()) throw new Error("Connector runtime working directory must be a directory");
  } else {
    await assertSafeExistingPath(root, unresolvedCwd, "runtime working directory", true);
  }

  const command = manifest.runtime.command;
  if (command === "node" || samePath(command, process.execPath)) {
    const args = [...(manifest.runtime.args ?? [])];
    if (args.length === 0) throw new Error("Connector Node runtime must name a bundle-contained script entrypoint");
    const scriptArgument = args[0];
    if (scriptArgument === undefined) throw new Error("Connector Node runtime must name a bundle-contained script entrypoint");
    const entrypointRelative = connectorRelativePath(root, scriptArgument, "Node script entrypoint", false);
    const unresolvedEntrypoint = resolve(root, entrypointRelative);
    let entrypoint = unresolvedEntrypoint;
    if (requireFiles) {
      entrypoint = await realpath(unresolvedEntrypoint);
      assertContained(root, entrypoint, "Node script entrypoint");
      if (!(await lstat(entrypoint)).isFile()) throw new Error("Connector Node script entrypoint must be a file");
    } else {
      await assertSafeExistingPath(root, unresolvedEntrypoint, "Node script entrypoint", false);
    }
    const canonicalEntrypoint = normalizedRelativePath(root, unresolvedEntrypoint);
    return {
      plan: executionPlan("node", canonicalEntrypoint, normalizedRelativeDirectory(root, unresolvedCwd), args.slice(1), manifest),
      command: process.execPath,
      args: requireFiles ? [entrypoint, ...args.slice(1)] : [scriptArgument, ...args.slice(1)],
      cwd,
    };
  }

  if (!isPathLike(command)) throw new Error("Connector runtime command must be 'node' or a bundle-relative executable");
  const executableRelative = connectorRelativePath(root, command, "runtime command", false);
  const unresolvedExecutable = resolve(root, executableRelative);
  let executable = unresolvedExecutable;
  if (requireFiles) {
    executable = await realpath(unresolvedExecutable);
    assertContained(root, executable, "runtime command");
    if (!(await lstat(executable)).isFile()) throw new Error("Connector runtime command must be a file");
  } else {
    await assertSafeExistingPath(root, unresolvedExecutable, "runtime command", false);
  }
  const args = [...(manifest.runtime.args ?? [])];
  return {
    plan: executionPlan("executable", normalizedRelativePath(root, unresolvedExecutable), normalizedRelativeDirectory(root, unresolvedCwd), args, manifest),
    command: executable,
    args,
    cwd,
  };
}

async function createVerifiedRuntimeCopy(
  sourceDirectory: string,
  approvedFingerprint: string,
  approvedPlan: DesktopConnectorExecutionPlan,
): Promise<RuntimeCopy> {
  const root = await mkdtemp(resolve(tmpdir(), RUNTIME_DIRECTORY_PREFIX));
  const directory = resolve(root, "bundle");
  try {
    await cp(sourceDirectory, directory, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const manifestPath = resolve(directory, MANIFEST_NAME);
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error("Copied connector manifest must be a regular file no larger than 256 KiB");
    }
    const manifest = await loadConnectorManifest(manifestPath);
    const execution = await resolveConnectorExecution(directory, manifest, true);
    const copiedFingerprint = await fingerprintDesktopConnectorTreeWithOptions(directory, execution.plan);
    if (!sameExecutionPlan(execution.plan, approvedPlan) || copiedFingerprint !== approvedFingerprint) {
      throw new Error("Connector source changed while creating its verified runtime copy");
    }
    return { root, directory, manifest, execution };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupStaleConnectorRuntimeCopies(
  temporaryDirectory = tmpdir(),
  now = Date.now(),
  staleAfterMs = STALE_RUNTIME_AGE_MS,
): Promise<number> {
  const entries = await readdir(temporaryDirectory, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(RUNTIME_DIRECTORY_PREFIX)).map(async (entry) => {
    const path = resolve(temporaryDirectory, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs < staleAfterMs) return;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }));
  return removed;
}

function executionPlan(
  launcher: DesktopConnectorExecutionPlan["launcher"],
  entrypoint: string,
  cwd: string,
  args: readonly string[],
  manifest: ConnectorManifestV1,
): DesktopConnectorExecutionPlan {
  return {
    launcher,
    entrypoint,
    cwd,
    args: [...args],
    platform: process.platform,
    architecture: process.arch,
    environmentNames: [...(manifest.runtime.env ?? [])].sort((left, right) => left.localeCompare(right)),
  };
}

function sameExecutionPlan(left: DesktopConnectorExecutionPlan, right: DesktopConnectorExecutionPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function connectorRelativePath(root: string, value: string, label: string, allowRoot: boolean): string {
  if (isAbsolute(value) || win32.isAbsolute(value)) throw new Error(`Connector ${label} must be bundle-relative`);
  const result = resolve(root, value);
  assertContained(root, result, label);
  const path = relative(root, result);
  if (!allowRoot && path === "") throw new Error(`Connector ${label} must name a file inside its bundle`);
  return path;
}

async function assertSafeExistingPath(root: string, value: string, label: string, requireDirectory: boolean): Promise<void> {
  const resolved = await realpath(value);
  assertContained(root, resolved, label);
  const info = await lstat(value);
  if (info.isSymbolicLink()) throw new Error(`Connector ${label} cannot be a symbolic link`);
  if (requireDirectory ? !info.isDirectory() : !info.isFile()) throw new Error(`Connector ${label} must be ${requireDirectory ? "a directory" : "a file"}`);
}

function normalizedRelativePath(root: string, value: string): string {
  const path = relative(root, value);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Connector execution path escapes its installation directory");
  return path.split(sep).join("/").normalize("NFC");
}

function normalizedRelativeDirectory(root: string, value: string): string {
  const path = relative(root, value);
  if (path === "") return ".";
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Connector working directory escapes its installation directory");
  return path.split(sep).join("/").normalize("NFC");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertContained(root: string, value: string, label: string): void {
  const path = relative(root, value);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`Connector ${label} escapes its installation directory`);
}

function assertAllowedConnectorIdentity(manifest: ConnectorManifestV1): void {
  if (RESERVED_IDS.has(manifest.id)) throw new Error(`Connector id ${manifest.id} is reserved`);
}

function connectorDescriptor(manifest: ConnectorManifestV1, fingerprint: string, directory: string): DesktopConnectorDescriptor {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source: "external",
    fingerprint,
    directory,
    permissions: manifest.permissions,
    capabilities: {
      attachments: manifest.capabilities.attachments,
      reasoningEfforts: manifest.capabilities.reasoningEfforts,
      messageQueue: manifest.capabilities.messageQueue,
    },
  };
}

function protocolCapabilities(value: ConnectorCapabilities): ProviderCapabilities {
  assertConnectorCapabilities(value);
  return {
    authentication: value.authentication,
    listSessions: value.listSessions,
    paginatedSessions: value.paginatedSessions,
    sessionHistory: value.sessionHistory,
    createSession: value.createSession,
    resumeSession: value.resumeSession,
    sendMessage: value.sendMessage,
    steering: value.steering,
    streamingText: value.streamingText,
    toolEvents: value.toolEvents,
    commandEvents: value.commandEvents,
    fileChanges: value.fileChanges,
    approvals: value.approvals,
    userInput: value.userInput,
    interrupt: value.interrupt,
    modelEnumeration: value.modelEnumeration,
    projectAssociation: value.projectAssociation,
    sessionRelationships: value.sessionRelationships,
    messageEditing: value.messageEditing,
    remoteConnectivity: "local",
    notes: ["External connector process using Tethoq connector protocol v1."],
  };
}

function assertConnectorCapabilities(value: ConnectorCapabilities): void {
  const required = [
    "authentication", "listSessions", "paginatedSessions", "sessionHistory", "createSession", "resumeSession", "sendMessage",
    "messageQueue", "steering", "streamingText", "toolEvents", "commandEvents", "fileChanges", "approvals", "userInput",
    "interrupt", "modelEnumeration", "projectAssociation", "sessionRelationships", "messageEditing", "attachments", "reasoningEfforts",
  ] as const;
  if (!isRecord(value) || required.some((key) => typeof value[key] !== "boolean")) throw new Error("Connector returned invalid capabilities");
}

function assertAuthStatus(providerId: string, value: AuthStatus): void {
  if (!isRecord(value)
    || (value.authenticated !== true && value.authenticated !== false && value.authenticated !== null)
    || typeof value.canAuthenticate !== "boolean"
    || !boundedStringArray(value.details, 1_000, 20_000)
    || (value.method !== undefined && !boundedString(value.method, 1, 1_000))
    || (value.accountLabel !== undefined && !boundedString(value.accountLabel, 1, 2_000))) {
    throw new Error(`Connector ${providerId} returned invalid authentication status`);
  }
}

function normalizeModel(providerId: string, model: ConnectorModelDescriptor): RemoteModel {
  assertConnectorModel(providerId, model);
  return {
    id: model.id,
    providerId,
    displayName: model.displayName,
    ...(model.description !== undefined ? { description: model.description } : {}),
    isDefault: model.isDefault,
    nativeMetadata: {
      ...(model.metadata ?? {}),
      ...(model.reasoningEfforts !== undefined ? { supportedReasoningEfforts: model.reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })) } : {}),
    },
  };
}

function normalizeEvent(providerId: string, event: ConnectorEvent): ProviderEvent {
  return {
    eventId: event.id,
    providerId,
    ...(event.sessionId !== undefined ? { providerSessionId: event.sessionId } : {}),
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
    ...(event.nativeEvent !== undefined ? { nativeEvent: event.nativeEvent } : {}),
    ...(event.approval !== undefined ? { approval: {
      providerRequestId: event.approval.requestId,
      providerSessionId: event.approval.sessionId,
      title: event.approval.title,
      ...(event.approval.reason !== undefined ? { reason: event.approval.reason } : {}),
      ...(event.approval.command !== undefined ? { command: event.approval.command } : {}),
      ...(event.approval.workingDirectory !== undefined ? { workingDirectory: event.approval.workingDirectory } : {}),
      affectedFiles: event.approval.affectedFiles,
      networkDestinations: event.approval.networkDestinations,
      choices: event.approval.choices,
      riskMetadata: event.approval.riskMetadata ?? {},
      ...(event.approval.expiresAt !== undefined ? { expiresAt: event.approval.expiresAt } : {}),
    } } : {}),
  };
}

function messageParams(providerSessionId: string, request: SendMessageRequest | EditMessageRequest) {
  return {
    sessionId: providerSessionId,
    requestId: request.requestId,
    content: request.content,
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    ...("attachments" in request && request.attachments !== undefined ? { attachments: request.attachments } : {}),
    ...("metadata" in request && request.metadata !== undefined ? { metadata: request.metadata } : {}),
  };
}

function sendResult(providerId: string, result: { readonly accepted: boolean; readonly turnId?: string; readonly details: readonly string[] }): SendMessageResult {
  if (!isRecord(result) || typeof result.accepted !== "boolean" || !boundedStringArray(result.details, 1_000, 20_000)
    || (result.turnId !== undefined && !boundedString(result.turnId, 1, 500))) {
    throw new Error(`Connector ${providerId} returned an invalid send result`);
  }
  return { accepted: result.accepted, ...(result.turnId !== undefined ? { providerTurnId: result.turnId } : {}), details: result.details };
}

function normalizeQueueMessage(providerId: string, message: ConnectorQueuedMessage): ProviderQueuedMessage {
  if (!isRecord(message)
    || !boundedString(message.id, 1, 500)
    || !boundedString(message.sessionId, 1, 500)
    || !boundedString(message.content, 0, MAX_STRING_LENGTH)
    || !["queued", "sending", "failed"].includes(message.state)
    || !validTimestamp(message.createdAt)
    || (message.error !== undefined && !boundedString(message.error, 1, 20_000))) {
    throw new Error(`Connector ${providerId} returned an invalid queued message`);
  }
  return { id: message.id, providerSessionId: message.sessionId, content: message.content, state: message.state, createdAt: message.createdAt, ...(message.error !== undefined ? { error: message.error } : {}) };
}

function assertConnectorSession(session: ConnectorSession): void {
  if (!isRecord(session)
    || !boundedString(session.id, 1, 500)
    || !boundedString(session.title, 1, 2_000)
    || !["idle", "working", "needs_input", "needs_approval", "completed", "failed", "disconnected", "unknown"].includes(session.state)
    || !validTimestamp(session.lastActivityAt)
    || typeof session.needsApproval !== "boolean") throw new Error("Connector returned an invalid session");
  for (const value of [session.workingDirectory, session.project, session.preview, session.modelId, session.reasoningEffort, session.parentSessionId]) {
    if (value !== undefined && !boundedString(value, 1, 20_000)) throw new Error("Connector returned an invalid session field");
  }
  if (session.createdAt !== undefined && !validTimestamp(session.createdAt)) throw new Error("Connector returned an invalid session timestamp");
  assertBoundedJson(session.metadata ?? {}, "session metadata");
}

function assertSessionListResult(providerId: string, value: { readonly sessions: readonly ConnectorSession[]; readonly nextCursor: string | null }): void {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_OUTPUT_ITEMS
    || (value.nextCursor !== null && !boundedString(value.nextCursor, 1, 10_000))) {
    throw new Error(`Connector ${providerId} returned an invalid session list`);
  }
}

function assertConnectorModel(providerId: string, model: ConnectorModelDescriptor): void {
  if (!isRecord(model)
    || !boundedString(model.id, 1, 500)
    || !boundedString(model.displayName, 1, 1_000)
    || typeof model.isDefault !== "boolean"
    || (model.description !== undefined && !boundedString(model.description, 1, 20_000))) {
    throw new Error(`Connector ${providerId} returned an invalid model`);
  }
  if (model.reasoningEfforts !== undefined
    && (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length > 100 || model.reasoningEfforts.some((effort) => !boundedString(effort, 1, 200)))) {
    throw new Error(`Connector ${providerId} returned invalid model reasoning efforts`);
  }
  assertBoundedJson(model.metadata ?? {}, "model metadata");
}

function assertConnectorMessage(providerId: string, message: ConnectorMessage): void {
  if (!isRecord(message)
    || !boundedString(message.id, 1, 500)
    || !boundedString(message.sessionId, 1, 500)
    || !["user", "assistant", "system", "tool"].includes(message.role)
    || !validTimestamp(message.createdAt)
    || (message.completedAt !== undefined && !validTimestamp(message.completedAt))
    || !Array.isArray(message.parts)
    || message.parts.length > 10_000
    || !["streaming", "completed", "failed"].includes(message.status)
    || (message.editable !== undefined && typeof message.editable !== "boolean")) {
    throw new Error(`Connector ${providerId} returned an invalid message`);
  }
  for (const part of message.parts) assertConnectorContentPart(providerId, part);
  assertBoundedJson(message.metadata ?? {}, "message metadata");
}

function assertConnectorContentPart(providerId: string, part: ConnectorMessage["parts"][number]): void {
  if (!isRecord(part) || !boundedString(part.type, 1, 50)) throw new Error(`Connector ${providerId} returned an invalid message part`);
  if (part.type === "text" || part.type === "reasoning") {
    if (!boundedString(part.text, 0, MAX_STRING_LENGTH) || (part.type === "reasoning" && typeof part.redacted !== "boolean")) throw new Error(`Connector ${providerId} returned an invalid text part`);
  } else if (part.type === "tool") {
    if (!boundedString(part.name, 1, 1_000)
      || !["pending", "running", "completed", "failed"].includes(part.status)
      || (part.callId !== undefined && !boundedString(part.callId, 1, 500))
      || (part.output !== undefined && !boundedString(part.output, 0, MAX_STRING_LENGTH))) throw new Error(`Connector ${providerId} returned an invalid tool part`);
  } else if (part.type === "command") {
    if (!boundedString(part.command, 1, MAX_STRING_LENGTH)
      || !["pending", "running", "completed", "failed"].includes(part.status)
      || (part.cwd !== undefined && !boundedString(part.cwd, 1, 50_000))
      || (part.output !== undefined && !boundedString(part.output, 0, MAX_STRING_LENGTH))
      || (part.exitCode !== undefined && (!Number.isSafeInteger(part.exitCode) || Math.abs(part.exitCode) > 1_000_000))) throw new Error(`Connector ${providerId} returned an invalid command part`);
  } else if (part.type === "file_change") {
    if (!boundedString(part.path, 1, 50_000) || !["added", "modified", "deleted", "unknown"].includes(part.change)
      || (part.patch !== undefined && !boundedString(part.patch, 0, MAX_STRING_LENGTH))) throw new Error(`Connector ${providerId} returned an invalid file change part`);
  } else if (part.type === "error") {
    if (!boundedString(part.message, 1, MAX_STRING_LENGTH)) throw new Error(`Connector ${providerId} returned an invalid error part`);
  } else if (part.type === "image") {
    if (part.uri !== undefined && !boundedString(part.uri, 1, MAX_STRING_LENGTH)) throw new Error(`Connector ${providerId} returned an invalid image part`);
    if (part.mimeType !== undefined && !boundedString(part.mimeType, 1, 500)) throw new Error(`Connector ${providerId} returned an invalid image part`);
    if (part.name !== undefined && !boundedString(part.name, 1, 10_000)) throw new Error(`Connector ${providerId} returned an invalid image part`);
  } else if (part.type === "file") {
    if (!boundedString(part.name, 1, 10_000) || (part.mimeType !== undefined && !boundedString(part.mimeType, 1, 500))) throw new Error(`Connector ${providerId} returned an invalid file part`);
  } else {
    throw new Error(`Connector ${providerId} returned an unknown message part`);
  }
  assertBoundedJson(part, "message part");
}

function assertConnectorEvent(providerId: string, event: ConnectorEvent, capabilities: ConnectorCapabilities): void {
  const knownTypes = new Set([
    "session.created", "session.updated", "session.status_changed", "message.started", "message.delta", "message.completed",
    "message.queued", "message.queue_updated", "message.queue_removed", "tool.started", "tool.output", "tool.completed",
    "command.started", "command.output", "command.completed", "file.changed", "approval.requested", "approval.resolved",
    "user_input.requested", "agent.error", "agent.completed", "agent.interrupted",
  ]);
  if (!isRecord(event)
    || !boundedString(event.id, 1, 500)
    || !knownTypes.has(event.type)
    || !validTimestamp(event.occurredAt)
    || (event.sessionId !== undefined && !boundedString(event.sessionId, 1, 500))) {
    throw new Error(`Connector ${providerId} emitted an invalid event`);
  }
  assertBoundedJson(event, "event");
  if (event.approval !== undefined) {
    if (!capabilities.approvals || event.type !== "approval.requested" || event.sessionId === undefined || event.approval.sessionId !== event.sessionId) {
      throw new Error(`Connector ${providerId} emitted an approval for another session`);
    }
    const approval = event.approval;
    if (!boundedString(approval.requestId, 1, 500)
      || !boundedString(approval.title, 1, 2_000)
      || !Array.isArray(approval.affectedFiles) || approval.affectedFiles.length > 1_000
      || approval.affectedFiles.some((item) => !boundedString(item, 1, 50_000))
      || !Array.isArray(approval.networkDestinations) || approval.networkDestinations.length > 1_000
      || approval.networkDestinations.some((item) => !boundedString(item, 1, 10_000))
      || !Array.isArray(approval.choices) || approval.choices.length < 1 || approval.choices.length > 100
      || approval.choices.some((choice) => !isRecord(choice)
        || !boundedString(choice.id, 1, 500)
        || !boundedString(choice.label, 1, 2_000)
        || typeof choice.kind !== "string"
        || !["approve", "reject", "other"].includes(choice.kind))
      || (approval.reason !== undefined && !boundedString(approval.reason, 1, 20_000))
      || (approval.command !== undefined && !boundedString(approval.command, 1, MAX_STRING_LENGTH))
      || (approval.workingDirectory !== undefined && !boundedString(approval.workingDirectory, 1, 50_000))
      || (approval.expiresAt !== undefined && !validTimestamp(approval.expiresAt))) {
      throw new Error(`Connector ${providerId} emitted an invalid approval`);
    }
  }
}

function assertBoundedJson(value: unknown, label: string): void {
  assertJsonDepth(value, MAX_JSON_DEPTH);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`Connector ${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) throw new Error(`Connector ${label} is too large`);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && !value.includes("\0");
}

function boundedStringArray(value: unknown, maximumItems: number, maximumLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, 0, maximumLength));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPathLike(value: string): boolean {
  return value.startsWith(".") || value.includes("/") || value.includes("\\");
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

function assertJsonDepth(value: unknown, maximum: number): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current.value === null || typeof current.value !== "object") continue;
    if (current.depth >= maximum) throw new Error("Connector output exceeds the maximum JSON depth");
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
}
