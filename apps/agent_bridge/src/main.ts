import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { AgentBridge } from "./bridge.js";
import { defaultConfigPath, loadOrCreateConfig, type BridgeConfig } from "./config.js";
import { PairingStateStore, defaultPairingStatePath } from "./pairing_store.js";
import { DelegationStateStore, defaultDelegationStatePath } from "./delegation_store.js";
import { SessionTransferStateStore, defaultSessionTransferStatePath } from "./session_transfer_store.js";
import { CrossSessionInboxStore, defaultCrossSessionInboxStatePath } from "./cross_session_store.js";
import { createConfiguredProviders } from "./providers.js";
import { BridgeRelayClient, BridgeSocketServer } from "./transport.js";
import { defaultMeshRuntimePath, MeshToolGateway } from "./mesh_tools.js";
import { installOpenCodeMeshTools, installOpenCodeImagePolicy } from "./opencode_tools.js";
import { installPiTools } from "./pi_tools.js";
import { installCodexMeshTools } from "./codex_tools.js";
import { resolveCodexCommand } from "../../../packages/provider_codex/src/index.js";
import { pairingQrText, validatePublicBridgeUrl } from "./pairing_qr.js";
import { openDefaultBrowser, startPairingPage, type PairingPage } from "./pairing_page.js";
import { startPhonePairTunnel, type PhonePairTunnel } from "./phone_pair_tunnel.js";
import { configuredDesktopLifecycle } from "./desktop_lifecycle.js";
import { CompanionControlServer } from "./companion_control.js";
import { tethoqEnvironmentFlag, tethoqEnvironmentValue } from "./environment.js";
import { defaultTranscriptionSourceRegistry } from "./dictation.js";
import { DictationCredentialStore, defaultDictationCredentialStatePath } from "./dictation_credentials.js";
import { GoalStore, defaultGoalStatePath } from "./goal_store.js";
import { ScheduledTaskStore, defaultScheduledTaskStatePath } from "./scheduled_task_store.js";
import { ScheduledTaskScheduler } from "./scheduled_tasks.js";
import { SessionCatalogueStore, defaultSessionCatalogueStatePath } from "./session_catalogue_store.js";
import { VisionProxyStore, defaultVisionProxyStatePath } from "./vision_proxy_store.js";
import {
  BridgeOwnedClientToolFailureStore,
  defaultBridgeOwnedClientToolFailureStatePath,
} from "./client_tool_failure_store.js";
import { QueueDeliveryStore, defaultQueueDeliveryStatePath } from "./queue_delivery_store.js";

interface CliOptions {
  readonly configPath: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly pair: boolean;
  readonly allowUnsignedLocal: boolean;
  readonly noRelay: boolean;
  readonly enableFake: boolean;
  readonly publicBridgeUrl?: string;
  readonly phonePair: boolean;
  readonly noOpen: boolean;
  readonly companionControl: boolean;
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`${flag} must be an integer between 0 and 65535`);
  return port;
}

function parseArgs(args: readonly string[]): CliOptions {
  let configPath = tethoqEnvironmentValue(process.env, "TETHOQ_CONFIG_PATH") ?? defaultConfigPath();
  let host = tethoqEnvironmentValue(process.env, "TETHOQ_BRIDGE_HOST") ?? "127.0.0.1";
  let port = parsePort(tethoqEnvironmentValue(process.env, "TETHOQ_BRIDGE_PORT") ?? "8765", "TETHOQ_BRIDGE_PORT");
  let path = tethoqEnvironmentValue(process.env, "TETHOQ_BRIDGE_PATH") ?? "/bridge";
  let pair = false;
  let allowUnsignedLocal = tethoqEnvironmentFlag(process.env, "TETHOQ_ALLOW_UNSIGNED_LOCAL");
  let noRelay = false;
  let enableFake = false;
  let publicBridgeUrl = tethoqEnvironmentValue(process.env, "TETHOQ_PUBLIC_BRIDGE_URL");
  let phonePair = false;
  let noOpen = false;
  let companionControl = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") configPath = args[++index] ?? throwMissing(arg);
    else if (arg === "--host") host = args[++index] ?? throwMissing(arg);
    else if (arg === "--port") port = parsePort(args[++index] ?? throwMissing(arg), arg);
    else if (arg === "--path") path = args[++index] ?? throwMissing(arg);
    else if (arg === "--pair") pair = true;
    else if (arg === "--allow-unsigned-local") allowUnsignedLocal = true;
    else if (arg === "--no-relay") noRelay = true;
    else if (arg === "--fake") enableFake = true;
    else if (arg === "--public-url") publicBridgeUrl = args[++index] ?? throwMissing(arg);
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--companion-control") companionControl = true;
    else if (arg === "--phone-pair") {
      phonePair = true;
      pair = true;
      noRelay = true;
    }
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: agent-bridge [--config PATH] [--host ADDRESS] [--port PORT] [--path PATH] [--pair] [--phone-pair] [--no-open] [--companion-control] [--public-url WSS_URL] [--no-relay] [--fake]");
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}`);
  }
  return {
    configPath,
    host,
    port,
    path,
    pair,
    allowUnsignedLocal,
    noRelay,
    enableFake,
    phonePair,
    noOpen,
    companionControl,
    ...(publicBridgeUrl !== undefined ? { publicBridgeUrl: validatePublicBridgeUrl(publicBridgeUrl) } : {}),
  };
}

function throwMissing(flag: string): never {
  throw new Error(`${flag} requires a value`);
}

const options = parseArgs(process.argv.slice(2));
const storedConfig = await loadOrCreateConfig(options.configPath);
const relayUrl = tethoqEnvironmentValue(process.env, "TETHOQ_RELAY_URL") ?? storedConfig.relayUrl;
const relayToken = tethoqEnvironmentValue(process.env, "TETHOQ_RELAY_TOKEN") ?? storedConfig.relayToken;
if (relayToken !== undefined && relayToken.length < 32) throw new Error("TETHOQ_RELAY_TOKEN must contain at least 32 characters");
const enabledProviders = options.enableFake && !storedConfig.enabledProviders.includes("fake")
  ? [...storedConfig.enabledProviders, "fake"]
  : storedConfig.enabledProviders;
const config: BridgeConfig = {
  ...storedConfig,
  enabledProviders,
  ...(relayUrl !== undefined ? { relayUrl } : {}),
  ...(relayToken !== undefined ? { relayToken } : {}),
};
const meshRuntimePath = defaultMeshRuntimePath(config.hostId);
const providerEnvironment: NodeJS.ProcessEnv = { ...process.env, UAR_MESH_RUNTIME: meshRuntimePath };
if (config.enabledProviders.includes("pi")) await installPiTools();
const pairingStore = new PairingStateStore(defaultPairingStatePath(options.configPath));
const pairingState = await pairingStore.read();
const delegationStore = new DelegationStateStore(defaultDelegationStatePath(options.configPath));
const delegationState = await delegationStore.read();
const sessionTransferStore = new SessionTransferStateStore(defaultSessionTransferStatePath(options.configPath));
const sessionTransferState = await sessionTransferStore.read();
const crossSessionStore = new CrossSessionInboxStore(defaultCrossSessionInboxStatePath(options.configPath));
const crossSessionState = await crossSessionStore.read();
const queueDeliveryStore = new QueueDeliveryStore(defaultQueueDeliveryStatePath(options.configPath), config.hostId);
const queueDeliveryState = await queueDeliveryStore.read();
const goalStore = new GoalStore(defaultGoalStatePath(options.configPath));
const goalState = await goalStore.read();
const sessionCatalogueStore = new SessionCatalogueStore(defaultSessionCatalogueStatePath(options.configPath), config.hostId);
const sessionCatalogue = await sessionCatalogueStore.read();
const visionProxyStore = new VisionProxyStore(defaultVisionProxyStatePath(options.configPath), config.hostId);
const visionProxyState = await visionProxyStore.read();
const clientToolFailureStore = new BridgeOwnedClientToolFailureStore(
  defaultBridgeOwnedClientToolFailureStatePath(options.configPath),
  config.hostId,
);
const clientToolFailureState = await clientToolFailureStore.read();
const dictationCredentialStore = new DictationCredentialStore(
  defaultDictationCredentialStatePath(options.configPath),
  config.identity.privateKeyPem,
);
const dictationCredentials = await dictationCredentialStore.read();
const transcriptionSources = defaultTranscriptionSourceRegistry({
  ...(dictationCredentials["openai-stt"] !== undefined ? { openAiApiKey: dictationCredentials["openai-stt"] } : {}),
  ...(dictationCredentials["xai-stt"] !== undefined ? { xAiApiKey: dictationCredentials["xai-stt"] } : {}),
});
let companionControl: CompanionControlServer | undefined;
const bridge = new AgentBridge(config, createConfiguredProviders(
  config,
  providerEnvironment,
  join(dirname(options.configPath), "direct-api-wallet.json"),
), {
  state: pairingState,
  presentedImageDirectory: join(dirname(options.configPath), "presented-images"),
  onStateChange: (state) => pairingStore.scheduleWrite(state),
  onPairingConfirmed: () => {
    console.log("TETHOQ_PAIRING_CONFIRMED");
    companionControl?.pairingConfirmed();
  },
  delegations: delegationState.tasks,
  onDelegationsChange: (tasks) => delegationStore.scheduleWrite(tasks),
  sessionTransfers: sessionTransferState.transfers,
  onSessionTransfersChange: (transfers) => sessionTransferStore.scheduleWrite(transfers),
  crossSessionMessages: crossSessionState.messages,
  onCrossSessionMessagesChange: (messages) => crossSessionStore.scheduleWrite(messages),
  queueDeliveries: queueDeliveryState.deliveries,
  onQueueDeliveriesChange: (deliveries) => queueDeliveryStore.scheduleWrite(deliveries),
  goals: goalState.goals,
  onGoalsChange: (goals) => goalStore.write(goals),
  sessionCatalogue,
  onSessionCatalogueChange: (sessions) => sessionCatalogueStore.scheduleWrite(sessions),
  visionProxies: visionProxyState.proxies,
  visionHelperSessionIds: visionProxyState.helperSessionIds,
  onVisionProxiesChange: (proxies, helperSessionIds) => visionProxyStore.scheduleWrite(proxies, helperSessionIds),
  bridgeOwnedClientToolFailures: clientToolFailureState.failures,
  onBridgeOwnedClientToolFailuresChange: (failures) => clientToolFailureStore.scheduleWrite(failures),
  transcriptionSources,
  onTranscriptionCredentialChange: (sourceId, apiKey) => {
    if (sourceId !== "openai-stt" && sourceId !== "xai-stt") throw new Error("Dictation source is not configurable");
    return dictationCredentialStore.set(sourceId, apiKey);
  },
});
const scheduledTaskStore = new ScheduledTaskStore(defaultScheduledTaskStatePath(options.configPath));
bridge.configureScheduledTasks(await ScheduledTaskScheduler.open({
  store: scheduledTaskStore,
  dispatch: async (task) => await bridge.dispatchScheduledTask(task),
  onChange: async ({ reason, task, previousTargetSessionId }) =>
    bridge.scheduledTaskChanged(task, reason, previousTargetSessionId),
  onError: (error) => console.error("Scheduled task reconciliation failed", error),
}));
const desktopLifecycle = configuredDesktopLifecycle();
const meshTools = new MeshToolGateway(
  config.hostId,
  (parentSessionId, tool, input, context) => bridge.executeClientTool(parentSessionId, tool, input, context),
  { runtimePath: meshRuntimePath },
);
let meshToolsReady = false;
try {
  await meshTools.listen();
  meshToolsReady = true;
} catch (error) {
  console.warn(`Mesh tool gateway is unavailable; continuing without mesh tools: ${error instanceof Error ? error.message : String(error)}`);
  await meshTools.close().catch(() => undefined);
}
if (meshToolsReady) bridge.configureClientTooling(meshTools);
await bridge.start();
if (meshToolsReady) {
  const toolInstallers: Promise<void>[] = [];
  const allowProviderConfigMutation = tethoqEnvironmentFlag(process.env, "TETHOQ_ALLOW_PROVIDER_CONFIG_MUTATION");
  if (!allowProviderConfigMutation && config.enabledProviders.some((providerId) => providerId === "codex" || providerId === "opencode")) {
    console.log("Provider-owned tool configuration was left unchanged. Set TETHOQ_ALLOW_PROVIDER_CONFIG_MUTATION=1 to install shared mesh tools.");
  }
  if (allowProviderConfigMutation && config.enabledProviders.includes("opencode")) {
    toolInstallers.push(Promise.all([installOpenCodeMeshTools(), installOpenCodeImagePolicy()]).then(() => undefined).catch((error: unknown) => {
      console.warn(`OpenCode mesh tool installation failed; OpenCode remains usable without mesh commands: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }
  if (allowProviderConfigMutation && config.enabledProviders.includes("codex")) {
    const configuredCodexCommand = tethoqEnvironmentValue(providerEnvironment, "TETHOQ_CODEX_COMMAND");
    toolInstallers.push(resolveCodexCommand({
      env: providerEnvironment,
      ...(configuredCodexCommand !== undefined ? { configuredCommand: configuredCodexCommand } : {}),
    }).then((selection) => installCodexMeshTools(meshTools.sharedMcpServer("provider"), selection.command))
      .catch((error: unknown) => {
        console.warn(`Codex mesh tool installation failed; Codex remains usable without shared mesh commands: ${error instanceof Error ? error.message : String(error)}`);
      }));
  }
  await Promise.all(toolInstallers);
}
const local = new BridgeSocketServer(bridge, {
  host: options.host,
  port: options.port,
  path: options.path,
  allowUnsignedRequests: options.allowUnsignedLocal,
  ...(desktopLifecycle !== undefined ? { desktopLifecycle } : {}),
});
await local.listen();
const address = local.address();
const renderedAddress = typeof address === "string" ? address : `${address?.address ?? options.host}:${address?.port ?? options.port}`;
console.log(`Agent Bridge ${config.hostId} listening at ws://${renderedAddress}${options.path}`);

if (options.companionControl) {
  if (options.host !== "127.0.0.1" || typeof address === "string") {
    throw new Error("--companion-control requires an IPv4 loopback TCP bridge");
  }
  const controlToken = process.env.TETHOQ_COMPANION_CONTROL_TOKEN;
  if (controlToken === undefined) throw new Error("TETHOQ_COMPANION_CONTROL_TOKEN is required");
  companionControl = new CompanionControlServer({
    token: controlToken,
    bridge,
    bridgePort: address?.port ?? options.port,
    bridgePath: options.path,
    ...(relayUrl !== undefined ? { relayUrl } : {}),
    ...(relayToken !== undefined ? { relayToken } : {}),
    onShutdown: () => { void shutdown("companion-control"); },
  });
  const controlAddress = await companionControl.listen();
  console.log(`TETHOQ_COMPANION_CONTROL_PORT=${controlAddress.port}`);
}

let relay: BridgeRelayClient | null = null;
if (!options.noRelay && relayUrl !== undefined) {
  if (relayToken === undefined) {
    console.warn("Relay URL is configured but no TETHOQ_RELAY_TOKEN is present; relay transport is disabled");
  } else {
    relay = new BridgeRelayClient(bridge, {
      url: relayUrl,
      token: relayToken,
      ...(desktopLifecycle !== undefined ? { desktopLifecycle } : {}),
    });
    try {
      await relay.start();
      console.log(`Agent Bridge connected outbound to ${relayUrl}`);
    } catch (error) {
      console.warn(`Initial relay connection failed; retrying in the background: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let phoneTunnel: PhonePairTunnel | null = null;
let pairingPage: PairingPage | null = null;
let publicBridgeUrl = options.publicBridgeUrl;
if (options.phonePair) {
  if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") {
    throw new Error("--phone-pair requires the bridge to remain bound to localhost");
  }
  const boundPort = typeof address === "string" ? options.port : (address?.port ?? options.port);
  console.log("Creating an encrypted temporary phone tunnel...");
  phoneTunnel = await startPhonePairTunnel(`http://127.0.0.1:${boundPort}`);
  const base = phoneTunnel.publicWebSocketBaseUrl.replace(/\/$/, "");
  publicBridgeUrl = validatePublicBridgeUrl(`${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`);
  console.log(`Temporary phone endpoint: ${publicBridgeUrl}`);
}

if (options.pair) {
  const effectiveToken = relayToken ?? randomBytes(32).toString("base64url");
  const payload = bridge.startPairing(relayUrl, relayUrl !== undefined ? effectiveToken : undefined);
  if (!options.phonePair) console.log("PAIRING_PAYLOAD=" + JSON.stringify(payload));
  const qrText = pairingQrText(payload, relayUrl === undefined ? publicBridgeUrl : undefined);
  if (options.phonePair) {
    pairingPage = await startPairingPage(qrText, payload.expiresAt);
    console.log(`Pairing page: ${pairingPage.url}`);
    if (!options.noOpen) {
      try {
        await openDefaultBrowser(pairingPage.url);
      } catch (error) {
        console.warn(`Could not open the pairing page automatically: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log("\nScan this connection code in Tethoq:\n");
  console.log(await QRCode.toString(qrText, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log(`Pairing QR expires ${payload.expiresAt}`);
  if (relayUrl === undefined && publicBridgeUrl === undefined) {
    console.warn("This QR contains no phone-reachable endpoint. Use --public-url wss://... for a physical phone.");
  }
  if (relayUrl !== undefined && relayToken === undefined) console.warn("The generated relay token is process-local; set TETHOQ_RELAY_TOKEN to a stable random value before production pairing");
}

const shutdown = async (signal: string) => {
  console.log(`Agent Bridge received ${signal}; shutting down`);
  await pairingPage?.dispose();
  await relay?.dispose();
  await phoneTunnel?.dispose();
  await companionControl?.dispose();
  await bridge.drainScheduledTasksForShutdown();
  await local.close();
  await meshTools.close();
  await bridge.dispose();
  await Promise.all([pairingStore.flush(), delegationStore.flush(), sessionTransferStore.flush(), crossSessionStore.flush(), queueDeliveryStore.flush(), dictationCredentialStore.flush(), goalStore.flush(), sessionCatalogueStore.flush(), visionProxyStore.flush(), clientToolFailureStore.flush()]);
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
