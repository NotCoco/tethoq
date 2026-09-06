import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  makeGlobalSessionId,
  type ConfigureWalletRequest,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type ProviderCapabilities,
  type ProviderWalletStatus,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionContextState,
  type SessionTokenUsage,
} from "../../protocol/src/index.js";
import {
  ProviderAdapterError,
  ProviderEventHub,
  providerDeveloperInstructions,
  stripProviderPromptGuidance,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type AuthStatus,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type MessageAttachment,
  type PaginatedSessions,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderClientTooling,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";

type DirectProtocol = "responses" | "chat_completions";
const maximumApiResponseBytes = 32 * 1024 * 1024;
const maximumErrorResponseBytes = 64 * 1024;
const maximumOutputImageBytes = 25 * 1024 * 1024;
// OpenCode Go/Zen route requests from the same conversation to the same
// provider for prompt caching. They require a stable per-conversation
// `x-opencode-session` header (enforced from 2026-09-06) and use the client
// name for attribution. See https://opencode.ai/docs/go/
const openCodeClientName = "tethoq";
const openCodeClientUserAgent = "tethoq/0.1.0";

function isOpenCodeCloudEndpoint(definition: EndpointDefinition): boolean {
  try {
    const hostname = new URL(definition.baseUrl).hostname.toLowerCase();
    if (hostname === "opencode.ai" || hostname.endsWith(".opencode.ai")) return true;
  } catch {
    // Fall through to the provider-id check below.
  }
  const ids = [definition.id.toLowerCase(), (definition.openCodeProviderId ?? "").toLowerCase()];
  return ids.some((id) => id.includes("opencode-go") || id.includes("opencode-zen") || id === "zen" || id.startsWith("zen:") || id.startsWith("zen/"));
}

function openCodeRoutingHeaders(definition: EndpointDefinition, sessionId?: string): Record<string, string> {
  if (!isOpenCodeCloudEndpoint(definition)) return {};
  return {
    "x-opencode-client": openCodeClientName,
    ...(sessionId !== undefined ? { "x-opencode-session": sessionId } : {}),
  };
}

interface ModelSeed {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly inputModalities?: readonly ("text" | "image" | "audio")[];
  readonly inputPricePerToken?: number;
  readonly outputPricePerToken?: number;
}

interface EndpointDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: DirectProtocol;
  readonly apiKeyEnvironment?: string;
  readonly apiKeyEnvironmentAliases?: readonly string[];
  readonly openCodeProviderId?: string;
  readonly usageUrl?: string;
  readonly models: readonly ModelSeed[];
}

interface EncryptedSecret {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface StoredEndpoint {
  definition?: EndpointDefinition;
  encryptedApiKey?: EncryptedSecret;
  balance?: number;
  spent: number;
}

interface StoredAttachment {
  readonly name: string;
  readonly mimeType?: string;
  readonly dataBase64?: string;
  readonly byteLength?: number;
  readonly uri?: string;
}

interface StoredMessage {
  readonly id: string;
  readonly providerMessageId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly images?: readonly StoredAttachment[];
  readonly audio?: readonly StoredAttachment[];
  readonly workflows?: SendMessageRequest["workflows"];
  readonly reasoning?: string;
  readonly createdAt: string;
}

interface StoredSession {
  readonly id: string;
  title: string;
  readonly workingDirectory: string;
  endpointId: string;
  modelId: string;
  reasoningEffort?: string;
  readonly clientTools?: "all" | "none";
  readonly createdAt: string;
  updatedAt: string;
  preview: string;
  state: "idle" | "working" | "completed" | "failed";
  contextWindow?: number;
  usage: SessionTokenUsage;
  readonly messages: StoredMessage[];
}

interface DirectState {
  readonly version: 1;
  readonly endpoints: Record<string, StoredEndpoint>;
  readonly sessions: StoredSession[];
}

interface ListedModel {
  readonly model: RemoteModel;
  readonly contextWindow?: number;
  readonly inputPricePerToken?: number;
  readonly outputPricePerToken?: number;
}

export interface DirectApiProviderOptions {
  readonly hostId: string;
  readonly statePath: string;
  readonly encryptionSecret: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly homeDirectory?: string;
}

const staticEndpoints: readonly EndpointDefinition[] = [
  {
    id: "openai",
    name: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
    apiKeyEnvironment: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1_050_000, inputModalities: ["text", "image"], inputPricePerToken: 5 / 1_000_000, outputPricePerToken: 30 / 1_000_000 },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 1_050_000, inputModalities: ["text", "image"], inputPricePerToken: 2 / 1_000_000, outputPricePerToken: 12 / 1_000_000 },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1_050_000, inputModalities: ["text", "image"] },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    protocol: "chat_completions",
    apiKeyEnvironment: "AI_GATEWAY_API_KEY",
    models: [
      { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol via Vercel", inputModalities: ["text", "image"] },
      { id: "zai/glm-5.2", name: "GLM-5.2 via Vercel", contextWindow: 1_000_000 },
    ],
  },
  {
    id: "zai",
    name: "Z.ai API",
    baseUrl: "https://api.z.ai/api/paas/v4",
    protocol: "chat_completions",
    apiKeyEnvironment: "ZAI_API_KEY",
    models: [
      { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000 },
      { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000 },
      { id: "glm-5", name: "GLM-5", contextWindow: 200_000 },
    ],
  },
  {
    id: "crof",
    name: "CrofAI",
    baseUrl: "https://crof.ai/v1",
    protocol: "chat_completions",
    apiKeyEnvironment: "CROFAI_API_KEY",
    usageUrl: "https://crof.ai/usage_api/",
    models: [
      { id: "glm-5.2", name: "GLM-5.2 via CrofAI", contextWindow: 1_000_000, inputPricePerToken: 0.30 / 1_000_000, outputPricePerToken: 1.05 / 1_000_000 },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro via CrofAI", contextWindow: 1_000_000, inputPricePerToken: 0.35 / 1_000_000, outputPricePerToken: 0.80 / 1_000_000 },
      { id: "kimi-k2.6", name: "Kimi K2.6 via CrofAI", contextWindow: 262_144, inputModalities: ["text", "image"], inputPricePerToken: 0.50 / 1_000_000, outputPricePerToken: 1.99 / 1_000_000 },
    ],
  },
  {
    id: "google",
    name: "Google Gemini API",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "chat_completions",
    apiKeyEnvironment: "GOOGLE_API_KEY",
    apiKeyEnvironmentAliases: ["GEMINI_API_KEY"],
    models: [
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextWindow: 1_048_576, inputModalities: ["text", "image", "audio"] },
    ],
  },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "chat_completions", apiKeyEnvironment: "OPENROUTER_API_KEY", models: [] },
  {
    id: "xai",
    name: "xAI API",
    baseUrl: "https://api.x.ai/v1",
    protocol: "chat_completions",
    apiKeyEnvironment: "XAI_API_KEY",
    // Existing Tethoq installations used GROK_API_KEY for the same first-party
    // xAI credential. Accept both names so EYES becomes available immediately
    // instead of asking the user to duplicate a working secret.
    apiKeyEnvironmentAliases: ["GROK_API_KEY"],
    models: [
      { id: "grok-4.6", name: "Grok 4.6", contextWindow: 500_000, inputModalities: ["text", "image"], inputPricePerToken: 2 / 1_000_000, outputPricePerToken: 6 / 1_000_000 },
    ],
  },
  { id: "deepseek", name: "DeepSeek API", baseUrl: "https://api.deepseek.com/v1", protocol: "chat_completions", apiKeyEnvironment: "DEEPSEEK_API_KEY", models: [] },
  { id: "groq", name: "Groq API", baseUrl: "https://api.groq.com/openai/v1", protocol: "chat_completions", apiKeyEnvironment: "GROQ_API_KEY", models: [] },
  { id: "mistral", name: "Mistral API", baseUrl: "https://api.mistral.ai/v1", protocol: "chat_completions", apiKeyEnvironment: "MISTRAL_API_KEY", models: [] },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", protocol: "chat_completions", apiKeyEnvironment: "TOGETHER_API_KEY", models: [] },
  { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", protocol: "chat_completions", apiKeyEnvironment: "FIREWORKS_API_KEY", models: [] },
  { id: "cerebras", name: "Cerebras API", baseUrl: "https://api.cerebras.ai/v1", protocol: "chat_completions", apiKeyEnvironment: "CEREBRAS_API_KEY", models: [] },
  { id: "perplexity", name: "Perplexity Agent API", baseUrl: "https://api.perplexity.ai/v1", protocol: "responses", apiKeyEnvironment: "PERPLEXITY_API_KEY", models: [] },
];

interface OpenCodePaths {
  readonly auth: string;
  readonly config: string;
  readonly models: string;
}

interface OpenCodeDiscovery {
  readonly keys: ReadonlyMap<string, string>;
  readonly endpoints: readonly EndpointDefinition[];
}

function openCodePaths(homeDirectory: string): OpenCodePaths {
  return {
    auth: join(homeDirectory, ".local", "share", "opencode", "auth.json"),
    config: join(homeDirectory, ".config", "opencode", "opencode.jsonc"),
    models: join(homeDirectory, ".cache", "opencode", "models.json"),
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonCFile(filePath: string): Promise<unknown> {
  try {
    const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/u, "");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // opencode.jsonc allows comments; strip them before retrying.
      return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"\\])\/\/[^\n]*/gmu, "$1")) as unknown;
    }
  } catch {
    return undefined;
  }
}

function openCodeApiKeys(value: unknown): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  if (!isObject(value)) return keys;
  for (const [providerId, entry] of Object.entries(value)) {
    if (!isObject(entry) || entry.type !== "api" || typeof entry.key !== "string") continue;
    const key = entry.key.trim();
    if (key === "") continue;
    keys.set(providerId, key);
  }
  return keys;
}

function openCodeConfigProviders(value: unknown): ReadonlyMap<string, { readonly name?: string; readonly baseUrl?: string }> {
  const providers = new Map<string, { readonly name?: string; readonly baseUrl?: string }>();
  if (!isObject(value)) return providers;
  const configured = isObject(value.provider) ? value.provider : {};
  for (const [providerId, entry] of Object.entries(configured)) {
    if (!isObject(entry)) continue;
    const options = isObject(entry.options) ? entry.options : {};
    const baseUrl = typeof options.baseURL === "string" ? options.baseURL : typeof entry.api === "string" ? entry.api : undefined;
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : undefined;
    providers.set(providerId, { ...(name !== undefined ? { name } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) });
  }
  return providers;
}

function openCodeProviders(value: unknown): ReadonlyMap<string, { readonly name?: string; readonly baseUrl?: string; readonly models: readonly ModelSeed[] }> {
  const providers = new Map<string, { readonly name?: string; readonly baseUrl?: string; readonly models: readonly ModelSeed[] }>();
  if (!isObject(value)) return providers;
  for (const [providerId, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue;
    const baseUrl = typeof entry.api === "string" ? entry.api : typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : undefined;
    const modelEntries = isObject(entry.models) ? entry.models : {};
    const models: ModelSeed[] = [];
    for (const [modelId, model] of Object.entries(modelEntries)) {
      if (!isObject(model)) continue;
      models.push({ id: modelId, name: typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : modelId });
    }
    providers.set(providerId, { ...(name !== undefined ? { name } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}), models });
  }
  return providers;
}

async function discoverOpenCodeEndpoints(paths: OpenCodePaths): Promise<OpenCodeDiscovery> {
  const [authValue, modelsValue, configValue] = await Promise.all([
    readJsonFile(paths.auth),
    readJsonFile(paths.models),
    readJsonCFile(paths.config),
  ]);
  const keys = openCodeApiKeys(authValue);
  if (keys.size === 0) return { keys, endpoints: [] };
  const providers = openCodeProviders(modelsValue);
  const configured = openCodeConfigProviders(configValue);
  const endpoints: EndpointDefinition[] = [];
  for (const providerId of keys.keys()) {
    if (staticEndpoints.some((preset) => preset.id === providerId)) continue;
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(providerId)) continue;
    const baseUrl = providers.get(providerId)?.baseUrl ?? configured.get(providerId)?.baseUrl;
    if (baseUrl === undefined || baseUrl.includes("${")) continue;
    let normalized: string;
    try {
      normalized = normalizedBaseUrl(baseUrl);
    } catch {
      continue;
    }
    endpoints.push({
      id: providerId,
      name: providers.get(providerId)?.name ?? configured.get(providerId)?.name ?? providerId,
      baseUrl: normalized,
      protocol: "chat_completions",
      openCodeProviderId: providerId,
      models: providers.get(providerId)?.models ?? [],
    });
  }
  return { keys, endpoints };
}

const capabilities: ProviderCapabilities = {
  authentication: true,
  listSessions: true,
  paginatedSessions: true,
  sessionHistory: true,
  createSession: true,
  resumeSession: true,
  sendMessage: true,
  steering: false,
  streamingText: false,
  toolEvents: true,
  commandEvents: false,
  fileChanges: false,
  approvals: false,
  userInput: false,
  interrupt: false,
  modelEnumeration: true,
  projectAssociation: true,
  sessionRelationships: false,
  messageEditing: false,
  remoteConnectivity: "documented_remote",
  notes: [
    "Calls documented APIs directly with a user-supplied API key.",
    "The displayed balance is provider-reported where available; otherwise it is a local spend budget, not stored money.",
  ],
};

function emptyState(): DirectState {
  return { version: 1, endpoints: {}, sessions: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

function directModelId(endpointId: string, modelId: string): string {
  return `${endpointId}::${modelId}`;
}

function splitDirectModelId(value: string): { endpointId: string; modelId: string } {
  const separator = value.indexOf("::");
  if (separator <= 0 || separator >= value.length - 2) throw new ProviderAdapterError("direct", "MODEL_INVALID", "Choose a direct API model from the catalog", false);
  return { endpointId: value.slice(0, separator), modelId: value.slice(separator + 2) };
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function apiKeyLabel(definition: EndpointDefinition): string {
  if (definition.openCodeProviderId !== undefined) return `opencode '${definition.openCodeProviderId}' key`;
  return [definition.apiKeyEnvironment, ...(definition.apiKeyEnvironmentAliases ?? [])].filter((name): name is string => name !== undefined).join(" / ");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  const local = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("Custom API endpoints must use HTTPS, except loopback development endpoints");
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function validateState(value: unknown): DirectState {
  if (!isObject(value) || value.version !== 1 || !isObject(value.endpoints) || !Array.isArray(value.sessions)) return emptyState();
  return value as unknown as DirectState;
}

export class DirectApiProviderAdapter implements AgentProviderAdapter {
  public readonly providerId = "direct";
  public readonly displayName = "Direct API";
  public readonly sessionCreationFeatures = { hiddenDeveloperInstructions: true, ephemeralSessions: false, selectableClientTools: true, visionToolIsolation: true } as const;
  readonly #hostId: string;
  readonly #statePath: string;
  readonly #key: Buffer;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #events = new ProviderEventHub();
  readonly #modelsCache = new Map<string, { readonly expiresAt: number; readonly models: readonly ListedModel[] }>();
  readonly #openCodePaths: OpenCodePaths;
  #openCodeEndpointsPromise: Promise<readonly EndpointDefinition[]> | undefined;
  #openCodeKeys: ReadonlyMap<string, string> = new Map();
  #statePromise: Promise<DirectState> | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #eventCounter = 0;
  #disposed = false;
  readonly #activePrompts = new Set<string>();
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(options: DirectApiProviderOptions) {
    this.#hostId = options.hostId;
    this.#statePath = options.statePath;
    this.#key = createHash("sha256").update(options.encryptionSecret, "utf8").digest();
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#openCodePaths = openCodePaths(options.homeDirectory ?? homedir());
  }

  public async detect(): Promise<ProviderDetection> {
    return { providerId: this.providerId, available: !this.#disposed, version: "openai-compatible-v1", executable: "in-process", details: ["Direct API catalog is available; individual endpoints require their own API key"] };
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const state = await this.state();
    const configured = (await this.definitions(state)).filter((definition) => this.apiKey(definition, state) !== undefined);
    return {
      authenticated: configured.length > 0,
      method: "user-api-key",
      ...(configured.length > 0 ? { accountLabel: `${configured.length} API endpoint${configured.length === 1 ? "" : "s"}` } : {}),
      canAuthenticate: true,
      details: configured.length > 0 ? configured.map((entry) => `${entry.name} key configured`) : ["Add an API key to the blue user wallet before sending a direct API request"],
    };
  }

  public async authenticate(request: AuthRequest): Promise<AuthResult> {
    const endpointId = typeof request.metadata?.endpointId === "string" ? request.metadata.endpointId : request.method;
    if (endpointId === undefined || request.credential === undefined) throw new ProviderAdapterError(this.providerId, "AUTH_CREDENTIAL_REQUIRED", "Choose an API endpoint and enter its API key", false);
    await this.configureWallet({ endpointId, apiKey: request.credential });
    return { authenticated: true, pending: false, details: [`API key saved for ${endpointId}`] };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return capabilities;
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    this.#clientTooling = tooling;
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    this.assertActive();
    const state = await this.state();
    const groups = await Promise.all((await this.definitions(state)).map((definition) => this.modelsForEndpoint(definition, state)));
    return groups.flatMap((group) => group.map((entry) => entry.model));
  }

  public async getWalletStatus(modelId?: string, requestedEndpointId?: string): Promise<ProviderWalletStatus> {
    const state = await this.state();
    const definitions = await this.definitions(state);
    const endpointId = requestedEndpointId?.trim()
      || (modelId === undefined ? definitions[0]?.id ?? "openai" : splitDirectModelId(modelId).endpointId);
    const definition = await this.requireDefinition(endpointId, state);
    const entry = state.endpoints[endpointId];
    const key = this.apiKey(definition, state);
    let providerBalance: number | undefined;
    if (definition.usageUrl !== undefined && key !== undefined) {
      try {
        const response = await this.fetchJson(definition.usageUrl, key, { method: "GET" }, 5_000, openCodeRoutingHeaders(definition));
        providerBalance = isObject(response) ? finiteNumber(response.credits) : undefined;
      } catch {
        // Balance reporting is optional and must not prevent chatting.
      }
    }
    const balance = providerBalance ?? (entry?.balance === undefined ? undefined : Math.max(0, entry.balance - entry.spent));
    const apiKeyName = `${definition.name.replace(/\s+API$/iu, "")} API key`;
    const detail = key === undefined
      ? `${apiKeyName} is required and not configured`
      : providerBalance !== undefined
        ? `${apiKeyName} is configured; provider balance was reported`
        : entry?.balance !== undefined
          ? `${apiKeyName} is configured with a local spend cap`
          : `${apiKeyName} is configured`;
    return {
      providerId: this.providerId,
      kind: "user_api",
      label: "User API wallet",
      detail,
      endpointId,
      endpointName: definition.name,
      currency: "USD",
      ...(balance !== undefined ? { balance } : {}),
      ...(entry?.spent !== undefined ? { spent: entry.spent } : {}),
      apiKeyConfigured: key !== undefined,
      apiKeyLabel: apiKeyLabel(definition),
      ...(key === undefined ? { caution: `Add the ${apiKeyName} before using this model` } : balance === undefined ? { caution: "No provider balance API is available; add an optional local spend budget if desired" } : {}),
      availableEndpoints: definitions.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        apiKeyLabel: apiKeyLabel(endpoint),
      })),
    };
  }

  public async configureWallet(request: ConfigureWalletRequest): Promise<ProviderWalletStatus> {
    this.assertActive();
    const endpointId = request.endpointId.trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(endpointId)) throw new Error("Endpoint ID must use 2-64 lowercase letters, numbers, dots, dashes, or underscores");
    if (request.clearBalance === true && (request.setBalance !== undefined || request.addBalance !== undefined)) throw new Error("clearBalance cannot be combined with a balance update");
    if (request.validateApiKey === true) {
      if (request.customEndpoint !== undefined) throw new Error("New custom endpoints cannot be verified before they are saved");
      const apiKey = request.apiKey?.trim();
      if (apiKey === undefined || apiKey.length < 8 || apiKey.length > 8_192 || apiKey.includes("\0")) throw new Error("API key length is invalid");
      const state = await this.state();
      const definition = (await this.definitions(state)).find((candidate) => candidate.id === endpointId);
      if (definition === undefined) throw new Error(`Unknown direct API endpoint ${endpointId}`);
      await this.validateApiKey(definition, apiKey);
    }
    await this.mutate(async (state) => {
      let definition = (await this.definitions(state)).find((candidate) => candidate.id === endpointId);
      if (request.customEndpoint !== undefined) {
        if (staticEndpoints.some((candidate) => candidate.id === endpointId)) throw new Error("Built-in direct API endpoints cannot be replaced");
        if (request.customEndpoint.id.trim() !== endpointId) throw new Error("Custom endpoint ID must match endpointId");
        const name = request.customEndpoint.name.trim();
        if (name.length === 0 || name.length > 120) throw new Error("Custom endpoint name must contain 1-120 characters");
        const modelIds = (request.customEndpoint.modelIds ?? []).map((id) => id.trim());
        if (modelIds.length > 100 || modelIds.some((id) => id.length === 0 || id.length > 240)) throw new Error("Custom endpoints accept at most 100 non-empty model IDs");
        definition = {
          id: endpointId,
          name,
          baseUrl: normalizedBaseUrl(request.customEndpoint.baseUrl),
          protocol: request.customEndpoint.protocol,
          apiKeyEnvironment: `TETHOQ_DIRECT_${endpointId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}_API_KEY`,
          models: [...new Set(modelIds)].map((id) => ({ id, name: id })),
        };
      }
      if (definition === undefined) throw new Error(`Unknown direct API endpoint ${endpointId}`);
      const current = state.endpoints[endpointId] ?? { spent: 0 };
      const previousDefinition = current.definition;
      const originChanged = request.customEndpoint !== undefined && previousDefinition !== undefined
        && (previousDefinition.baseUrl !== definition.baseUrl || previousDefinition.protocol !== definition.protocol);
      const environmentKey = this.environmentApiKey(definition);
      if (environmentKey !== undefined && request.clearApiKey === true) {
        throw new Error(`${environmentKey.name} is set in the environment; update or remove it there`);
      }
      if (environmentKey !== undefined && originChanged) {
        throw new Error(`${environmentKey.name} is set in the environment; remove it before changing this endpoint's origin`);
      }
      state.endpoints[endpointId] = current;
      if (request.customEndpoint !== undefined) {
        if (originChanged) delete current.encryptedApiKey;
        current.definition = definition;
      }
      if (request.apiKey !== undefined) {
        const apiKey = request.apiKey.trim();
        if (apiKey.length < 8 || apiKey.length > 8_192 || apiKey.includes("\0")) throw new Error("API key length is invalid");
        current.encryptedApiKey = this.encrypt(endpointId, apiKey);
      }
      if (request.clearApiKey === true) delete current.encryptedApiKey;
      if (request.clearBalance === true) delete current.balance;
      else {
        if (request.setBalance !== undefined) current.balance = this.balanceValue(request.setBalance);
        if (request.addBalance !== undefined) current.balance = this.balanceValue((current.balance ?? 0) + request.addBalance);
      }
      this.#modelsCache.delete(endpointId);
    });
    return await this.getWalletStatus(directModelId(endpointId, (await this.requireDefinition(endpointId, await this.state())).models[0]?.id ?? "default"));
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const state = await this.state();
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Session cursor is invalid");
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const sessions = state.sessions
      .filter((session) => options.workingDirectory === undefined || session.workingDirectory === options.workingDirectory)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = sessions.slice(offset, offset + limit).map((session) => this.remoteSession(session));
    const next = offset + page.length;
    return { sessions: page, nextCursor: next < sessions.length ? String(next) : null };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    return this.remoteSession(await this.requireSession(providerSessionId));
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const session = await this.requireSession(providerSessionId);
    return session.messages.map((message) => this.remoteMessage(session, message));
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    this.assertActive();
    const selected = splitDirectModelId(options.modelId ?? "openai::gpt-5.6-terra");
    const state = await this.state();
    const definition = await this.requireDefinition(selected.endpointId, state);
    if (this.apiKey(definition, state) === undefined) throw new ProviderAdapterError(this.providerId, "AUTH_REQUIRED", `Enter a ${definition.name} API key in the blue user wallet`, false);
    const model = (await this.modelsForEndpoint(definition, state)).find((candidate) => candidate.model.id === directModelId(selected.endpointId, selected.modelId));
    const now = this.#now().toISOString();
    const session: StoredSession = {
      id: `direct_${randomUUID()}`,
      title: options.title ?? options.firstInstruction?.slice(0, 72) ?? `${definition.name} chat`,
      workingDirectory: options.workingDirectory,
      endpointId: selected.endpointId,
      modelId: selected.modelId,
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      clientTools: options.clientTools ?? "all",
      createdAt: now,
      updatedAt: now,
      preview: options.firstInstruction ?? "",
      state: "idle",
      ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      usage: {},
      messages: options.developerInstructions === undefined ? [] : [{
        id: `system_${randomUUID()}`,
        providerMessageId: `system_${randomUUID()}`,
        role: "system",
        text: options.developerInstructions,
        createdAt: now,
      }],
    };
    await this.mutate(async (current) => { current.sessions.push(session); });
    await this.emit({ type: "session.created", providerSessionId: session.id, payload: { title: session.title, endpointId: session.endpointId } });
    if (options.firstInstruction !== undefined) await this.sendMessage(session.id, {
      requestId: `create_${randomUUID()}`,
      content: options.firstInstruction,
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    });
    return this.remoteSession(session);
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    await this.mutate(async () => { const session = await this.requireSession(providerSessionId); session.state = "idle"; session.updatedAt = this.#now().toISOString(); });
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.assertActive();
    const session = await this.requireSession(providerSessionId);
    const state = await this.state();
    const selected = request.modelId === undefined
      ? { endpointId: session.endpointId, modelId: session.modelId }
      : splitDirectModelId(request.modelId);
    const definition = await this.requireDefinition(selected.endpointId, state);
    if (this.apiKey(definition, state) === undefined) throw new ProviderAdapterError(this.providerId, "AUTH_REQUIRED", `Enter a ${definition.name} API key in the blue user wallet`, false);
    const wallet = state.endpoints[definition.id];
    if (wallet?.balance !== undefined && wallet.spent >= wallet.balance) {
      throw new ProviderAdapterError(this.providerId, "LOCAL_BUDGET_EXHAUSTED", `${definition.name}'s local spend budget has been reached. Raise it in the blue user wallet before sending another request.`, false);
    }
    const now = this.#now().toISOString();
    const { imageAttachments, audioAttachments } = splitDirectAttachments(request.attachments ?? []);
    const selectedModel = (await this.modelsForEndpoint(definition, state)).find((candidate) => candidate.model.id === directModelId(selected.endpointId, selected.modelId));
    const user: StoredMessage = {
      id: `user_${randomUUID()}`,
      providerMessageId: request.requestId,
      role: "user",
      text: request.content,
      ...(imageAttachments.length ? { images: imageAttachments } : {}),
      ...(audioAttachments.length ? { audio: audioAttachments } : {}),
      ...(request.workflows?.length ? { workflows: request.workflows.map((workflow) => ({ ...workflow })) } : {}),
      createdAt: now,
    };
    await this.mutate(async () => {
      session.endpointId = selected.endpointId;
      session.modelId = selected.modelId;
      if (request.reasoningEffort !== undefined) session.reasoningEffort = request.reasoningEffort;
      if (selectedModel?.contextWindow === undefined) delete session.contextWindow;
      else session.contextWindow = selectedModel.contextWindow;
      session.messages.push(user);
      const visibleContent = stripProviderPromptGuidance(request.content);
      if (visibleContent.trim()) session.preview = visibleContent;
      session.updatedAt = now;
      session.state = "working";
    });
    const providerTurnId = `turn_${randomUUID()}`;
    this.#activePrompts.add(session.id);
    void this.completeTurn(session, definition, request, providerTurnId);
    return { accepted: true, providerTurnId, details: [`Using ${definition.name} user API wallet`] };
  }

  public hasActiveTurn(providerSessionId: string): boolean {
    return this.#activePrompts.has(providerSessionId);
  }

  public async getSessionContext(providerSessionId: string): Promise<Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">> {
    const session = await this.requireSession(providerSessionId);
    const usedTokens = session.usage.totalTokens ?? null;
    return {
      modelId: directModelId(session.endpointId, session.modelId),
      usedTokens,
      contextWindowTokens: session.contextWindow ?? null,
      usedPercent: usedTokens !== null && session.contextWindow !== undefined && session.contextWindow > 0 ? Math.min(100, (usedTokens / session.contextWindow) * 100) : null,
      supportsManualCompaction: true,
      updatedAt: session.updatedAt,
      usage: session.usage,
    };
  }

  public async compactSession(providerSessionId: string): Promise<void> {
    await this.mutate(async () => {
      const session = await this.requireSession(providerSessionId);
      if (session.messages.length <= 8) return;
      const removed = session.messages.slice(0, -6);
      const summary = localTranscriptSummary(removed);
      session.messages.splice(0, removed.length, {
        id: `compact_${randomUUID()}`,
        providerMessageId: `compact_${randomUUID()}`,
        role: "system",
        text: `Earlier conversation summary:\n${summary}`,
        createdAt: this.#now().toISOString(),
      });
      session.usage = {};
      session.updatedAt = this.#now().toISOString();
    });
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    return this.#events.subscribe(providerSessionId, sink);
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    this.#events.clear();
    await this.#writeChain;
  }

  private async completeTurn(session: StoredSession, definition: EndpointDefinition, request: SendMessageRequest, providerTurnId: string): Promise<void> {
    const assistantId = `assistant_${randomUUID()}`;
    try {
      await this.emit({ type: "message.started", providerSessionId: session.id, payload: { messageId: assistantId, role: "assistant" } });
      const key = this.apiKey(definition, await this.state());
      if (key === undefined) throw new Error(`${definition.name} API key is unavailable`);
      const response = definition.protocol === "responses"
        ? await this.callResponses(session, definition, key, request)
        : await this.callChatCompletions(session, definition, key, request);
      const createdAt = this.#now().toISOString();
      const assistant: StoredMessage = {
        id: assistantId,
        providerMessageId: assistantId,
        role: "assistant",
        text: response.text,
        ...(response.images.length ? { images: response.images } : {}),
        ...(response.reasoning !== undefined ? { reasoning: response.reasoning } : {}),
        createdAt,
      };
      await this.mutate(async (state) => {
        session.messages.push(assistant);
        session.state = "completed";
        session.preview = response.text.slice(0, 240);
        session.updatedAt = createdAt;
        session.usage = mergeUsage(session.usage, response.usage);
        const endpoint = state.endpoints[definition.id] ?? { spent: 0 };
        state.endpoints[definition.id] = endpoint;
        if (response.usage.cost !== undefined) endpoint.spent += response.usage.cost;
      });
      if (response.reasoning !== undefined) await this.emit({ type: "message.delta", providerSessionId: session.id, payload: { messageId: assistantId, partType: "reasoning", reasoning: response.reasoning } });
      if (response.text !== "") await this.emit({ type: "message.delta", providerSessionId: session.id, payload: { messageId: assistantId, text: response.text } });
      await this.emit({ type: "message.completed", providerSessionId: session.id, payload: { messageId: assistantId, role: "assistant", parts: this.remoteMessage(session, assistant).parts } as unknown as JsonObject });
      this.#activePrompts.delete(session.id);
      await this.emit({ type: "agent.completed", providerSessionId: session.id, payload: { providerTurnId, usage: response.usage as JsonObject } });
    } catch (error) {
      await this.mutate(async () => { session.state = "failed"; session.updatedAt = this.#now().toISOString(); });
      this.#activePrompts.delete(session.id);
      await this.emit({ type: "agent.error", providerSessionId: session.id, payload: { message: error instanceof Error ? error.message : String(error), providerTurnId } });
    }
  }

  private async callChatCompletions(session: StoredSession, definition: EndpointDefinition, key: string, request: SendMessageRequest): Promise<{ readonly text: string; readonly reasoning?: string; readonly images: readonly StoredAttachment[]; readonly usage: SessionTokenUsage }> {
    const messages: Record<string, unknown>[] = session.messages.map((message) => chatMessage(message));
    const developerInstructions = providerDeveloperInstructions(request);
    if (developerInstructions !== undefined) {
      messages.splice(Math.max(0, messages.length - 1), 0, { role: "system", content: developerInstructions });
    }
    const tools = this.directTools(session, "chat_completions");
    let usage: SessionTokenUsage = {};
    for (let round = 0; round < 8; round += 1) {
      const body: Record<string, unknown> = {
        model: session.modelId,
        messages,
        stream: false,
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.reasoningEffort !== undefined && request.reasoningEffort.toLowerCase() !== "default" ? { reasoning_effort: request.reasoningEffort.toLowerCase() } : {}),
      };
      const value = await this.fetchJson(endpointUrl(definition.baseUrl, "chat/completions"), key, { method: "POST", body: JSON.stringify(body) }, 180_000, openCodeRoutingHeaders(definition, session.id));
      const root = isObject(value) ? value : {};
      usage = mergeUsage(usage, parseUsage(root.usage));
      const choices = Array.isArray(root.choices) ? root.choices : [];
      const first = isObject(choices[0]) ? choices[0] : {};
      const message = isObject(first.message) ? first.message : {};
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
      if (calls.length > 0) {
        if (tools.length === 0) throw new Error("The model requested a tool for a session with client tools disabled");
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const fn = isObject(call.function) ? call.function : {};
          const name = typeof fn.name === "string" ? fn.name : "";
          const callId = typeof call.id === "string" ? call.id : `call_${randomUUID()}`;
          const input = parseToolArguments(fn.arguments);
          const output = await this.executeDirectTool(session, callId, name, input);
          messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(output) });
        }
        continue;
      }
      const parsed = parseAssistantContent(message.content);
      const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
      const cost = usage.cost === undefined ? pricedCost(usage, await this.modelPricing(definition, session.modelId, await this.state())) : undefined;
      return { text: parsed.text, ...(reasoning !== undefined ? { reasoning } : {}), images: parsed.images, usage: { ...usage, ...(cost !== undefined ? { cost, currency: "USD" } : {}) } };
    }
    throw new Error("The direct model exceeded the eight-round client-tool limit");
  }

  private async callResponses(session: StoredSession, definition: EndpointDefinition, key: string, request: SendMessageRequest): Promise<{ readonly text: string; readonly reasoning?: string; readonly images: readonly StoredAttachment[]; readonly usage: SessionTokenUsage }> {
    let input: unknown[] = session.messages.map((message) => ({
      role: message.role,
      content: [
        ...(message.text === "" ? [] : [{ type: "input_text", text: message.text }]),
        ...(message.images ?? []).map((image) => ({ type: "input_image", image_url: storedImageUri(image) })),
        ...(message.audio ?? []).map((audio) => ({ type: "input_audio", input_audio: inputAudio(audio) })),
      ],
    }));
    const tools = this.directTools(session, "responses");
    let usage: SessionTokenUsage = {};
    const developerInstructions = providerDeveloperInstructions(request);
    for (let round = 0; round < 8; round += 1) {
      const body: Record<string, unknown> = {
        model: session.modelId,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(developerInstructions !== undefined ? { instructions: developerInstructions } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.reasoningEffort !== undefined && request.reasoningEffort.toLowerCase() !== "default" ? { reasoning: { effort: request.reasoningEffort.toLowerCase() } } : {}),
      };
      const value = await this.fetchJson(endpointUrl(definition.baseUrl, "responses"), key, { method: "POST", body: JSON.stringify(body) }, 180_000, openCodeRoutingHeaders(definition, session.id));
      const root = isObject(value) ? value : {};
      usage = mergeUsage(usage, parseResponsesUsage(root.usage));
      const output = Array.isArray(root.output) ? root.output : [];
      const calls = output.filter((item): item is Record<string, unknown> => isObject(item) && item.type === "function_call");
      if (calls.length > 0) {
        if (tools.length === 0) throw new Error("The model requested a tool for a session with client tools disabled");
        const results = [];
        for (const call of calls) {
          const name = typeof call.name === "string" ? call.name : "";
          const callId = typeof call.call_id === "string" ? call.call_id : `call_${randomUUID()}`;
          const toolInput = parseToolArguments(call.arguments);
          const toolOutput = await this.executeDirectTool(session, callId, name, toolInput);
          results.push({ type: "function_call_output", call_id: callId, output: JSON.stringify(toolOutput) });
        }
        input = [...input, ...output, ...results];
        continue;
      }
      const parsed = parseResponsesOutput(root);
      const cost = usage.cost === undefined ? pricedCost(usage, await this.modelPricing(definition, session.modelId, await this.state())) : undefined;
      return { ...parsed, usage: { ...usage, ...(cost !== undefined ? { cost, currency: "USD" } : {}) } };
    }
    throw new Error("The direct model exceeded the eight-round client-tool limit");
  }

  private directTools(session: StoredSession, protocol: DirectProtocol): readonly Record<string, unknown>[] {
    if (session.clientTools === "none" || this.#clientTooling === undefined) return [];
    return this.#clientTooling.definitions.map((definition) => protocol === "responses"
      ? { type: "function", name: definition.name, description: definition.description, parameters: definition.inputSchema }
      : { type: "function", function: { name: definition.name, description: definition.description, parameters: definition.inputSchema } });
  }

  private async executeDirectTool(session: StoredSession, callId: string, name: string, input: JsonObject): Promise<JsonValue> {
    const tooling = this.#clientTooling;
    if (tooling === undefined || name.length === 0 || !tooling.definitions.some((definition) => definition.name === name)) {
      throw new Error(`The model requested unavailable client tool ${name || "(unnamed)"}`);
    }
    await this.emit({ type: "tool.started", providerSessionId: session.id, payload: { name, callId, input } });
    try {
      const output = await tooling.execute(this.providerId, session.id, name, input, {
        callId,
        lifecycleOwner: "provider",
      });
      await this.emit({ type: "tool.completed", providerSessionId: session.id, payload: { name, callId, status: "completed", output } });
      return output;
    } catch (error) {
      const eyesFailure = isDirectEyesTool(name);
      const message = eyesFailure
        ? safeDirectEyesToolError(error)
        : error instanceof Error ? error.message : String(error);
      await this.emit({ type: "tool.completed", providerSessionId: session.id, payload: { name, callId, status: "failed", error: message } });
      // Tool failures are valid model input. In particular, returning a safe
      // EYES failure lets the parent model explain the problem and suggest a
      // different visual model instead of crashing the entire parent turn.
      if (eyesFailure) return { error: message };
      throw error;
    }
  }

  private async modelsForEndpoint(definition: EndpointDefinition, state: DirectState): Promise<readonly ListedModel[]> {
    const cached = this.#modelsCache.get(definition.id);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models;
    const key = this.apiKey(definition, state);
    const seeds = (verified: boolean) => definition.models.map((seed) =>
      this.listedModel(definition, seed, key !== undefined, verified));
    // Catalog discovery is credential-gated so opening Tethoq never probes a
    // third-party endpoint merely to populate the initial model picker.
    if (key === undefined) return seeds(false);
    try {
      const value = await this.fetchJson(endpointUrl(definition.baseUrl, "models"), key, { method: "GET" }, 8_000, openCodeRoutingHeaders(definition));
      const root = isObject(value) ? value : {};
      if (!Array.isArray(root.data)) throw new Error("Model catalogue response is invalid");
      const data = root.data;
      const discoveredModelIds = new Set(data.flatMap((entry) =>
        isObject(entry) && typeof entry.id === "string" ? [entry.id] : []));
      const discovered = data.flatMap((entry): ListedModel[] => {
        if (!isObject(entry) || typeof entry.id !== "string") return [];
        const architecture = isObject(entry.architecture) ? entry.architecture : {};
        const supported = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
        const modalities: Array<"text" | "image" | "audio"> = [
          "text",
          ...(supported.includes("image") ? ["image"] as const : []),
          ...(supported.includes("audio") ? ["audio"] as const : []),
        ];
        return [this.listedModel(definition, {
          id: entry.id,
          name: typeof entry.name === "string" ? entry.name : entry.id,
          ...(integer(entry.context_length ?? entry.context_window) !== undefined ? { contextWindow: integer(entry.context_length ?? entry.context_window)! } : {}),
          inputModalities: modalities,
        }, true, true)];
      });
      const verifiedSeeds = definition.models.map((seed) =>
        this.listedModel(definition, seed, true, discoveredModelIds.has(seed.id)));
      const combined = dedupeModels([...verifiedSeeds, ...discovered]);
      this.#modelsCache.set(definition.id, { expiresAt: Date.now() + 5 * 60_000, models: combined });
      return combined;
    } catch {
      // Keep the ordinary catalogue usable, but mark these seed rows as
      // unverified so EYES never claims a failed/unauthorized endpoint is ready.
      return seeds(false);
    }
  }

  private listedModel(
    definition: EndpointDefinition,
    seed: ModelSeed,
    keyConfigured: boolean,
    apiKeyVerified: boolean,
  ): ListedModel {
    const inputModalities = seed.inputModalities ?? ["text"];
    return {
      model: {
        id: directModelId(definition.id, seed.id),
        providerId: this.providerId,
        displayName: seed.name,
        description: `${definition.name} direct API`,
        isDefault: definition.id === "openai" && seed.id === "gpt-5.6-terra",
        inputModalities,
        nativeMetadata: {
          sourceProviderId: definition.id,
          sourceProviderName: definition.name,
          walletKind: "user_api",
          apiKeyConfigured: keyConfigured,
          apiKeyVerified,
          apiKeyLabel: apiKeyLabel(definition),
          protocol: definition.protocol,
          ...(seed.contextWindow !== undefined ? { contextWindow: seed.contextWindow } : {}),
          ...(seed.inputPricePerToken !== undefined || seed.outputPricePerToken !== undefined ? { pricing: { ...(seed.inputPricePerToken !== undefined ? { input: seed.inputPricePerToken } : {}), ...(seed.outputPricePerToken !== undefined ? { output: seed.outputPricePerToken } : {}) } } : {}),
        },
      },
      ...(seed.contextWindow !== undefined ? { contextWindow: seed.contextWindow } : {}),
      ...(seed.inputPricePerToken !== undefined ? { inputPricePerToken: seed.inputPricePerToken } : {}),
      ...(seed.outputPricePerToken !== undefined ? { outputPricePerToken: seed.outputPricePerToken } : {}),
    };
  }

  private async modelPricing(definition: EndpointDefinition, modelId: string, state: DirectState): Promise<Pick<ListedModel, "inputPricePerToken" | "outputPricePerToken">> {
    return (await this.modelsForEndpoint(definition, state)).find((entry) => entry.model.id === directModelId(definition.id, modelId)) ?? {};
  }

  private async definitions(state: DirectState): Promise<readonly EndpointDefinition[]> {
    const custom = Object.values(state.endpoints).flatMap((entry) => entry.definition === undefined ? [] : [entry.definition]);
    const discovered = (await this.openCodeEndpoints()).filter((entry) => !staticEndpoints.some((preset) => preset.id === entry.id) && !custom.some((candidate) => candidate.id === entry.id));
    return [...staticEndpoints, ...custom.filter((entry) => !staticEndpoints.some((preset) => preset.id === entry.id)), ...discovered];
  }

  private async requireDefinition(endpointId: string, state: DirectState): Promise<EndpointDefinition> {
    const definition = (await this.definitions(state)).find((entry) => entry.id === endpointId);
    if (definition === undefined) throw new ProviderAdapterError(this.providerId, "ENDPOINT_UNKNOWN", `Unknown direct API endpoint ${endpointId}`, false);
    return definition;
  }

  private openCodeEndpoints(): Promise<readonly EndpointDefinition[]> {
    if (this.#openCodeEndpointsPromise === undefined) {
      this.#openCodeEndpointsPromise = (async () => {
        try {
          const discovered = await discoverOpenCodeEndpoints(this.#openCodePaths);
          this.#openCodeKeys = discovered.keys;
          return discovered.endpoints;
        } catch {
          return [];
        }
      })();
    }
    return this.#openCodeEndpointsPromise;
  }

  private apiKey(definition: EndpointDefinition, state: DirectState): string | undefined {
    if (definition.openCodeProviderId !== undefined) return this.#openCodeKeys.get(definition.openCodeProviderId);
    const encrypted = state.endpoints[definition.id]?.encryptedApiKey;
    // A key explicitly saved in Tethoq must replace an inherited environment
    // key, otherwise validation succeeds but subsequent EYES calls use the old key.
    if (encrypted !== undefined) {
      try { return this.decrypt(definition.id, encrypted); } catch { return undefined; }
    }
    return this.environmentApiKey(definition)?.value;
  }

  private environmentApiKey(definition: EndpointDefinition): { readonly name: string; readonly value: string } | undefined {
    for (const name of [definition.apiKeyEnvironment, ...(definition.apiKeyEnvironmentAliases ?? [])]) {
      if (name === undefined) continue;
      const value = this.#environment[name]?.trim();
      if (value) return { name, value };
    }
    return undefined;
  }

  private encrypt(endpointId: string, value: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(endpointId, "utf8"));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private decrypt(endpointId: string, secret: EncryptedSecret): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(secret.iv, "base64"));
    decipher.setAAD(Buffer.from(endpointId, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.data, "base64")), decipher.final()]).toString("utf8");
  }

  private async state(): Promise<DirectState> {
    if (this.#statePromise !== undefined) return await this.#statePromise;
    this.#statePromise = (async () => {
      try {
        const state = validateState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
        // A persisted working flag cannot represent a recoverable in-flight
        // HTTP request after process restart. Mark it terminal so new input is
        // never trapped behind a turn that no longer exists.
        for (const session of state.sessions) {
          if (session.state === "working") session.state = "failed";
        }
        return state;
      }
      catch { return emptyState(); }
    })();
    return await this.#statePromise;
  }

  private async mutate(action: (state: DirectState) => void | Promise<void>): Promise<void> {
    const run = this.#writeChain.then(async () => {
      const state = await this.state();
      await action(state);
      await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#statePath);
    });
    this.#writeChain = run.catch(() => undefined);
    await run;
  }

  private async requireSession(providerSessionId: string): Promise<StoredSession> {
    const session = (await this.state()).sessions.find((entry) => entry.id === providerSessionId);
    if (session === undefined) throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", `Direct API session ${providerSessionId} was not found`, false);
    return session;
  }

  private remoteSession(session: StoredSession): RemoteSession {
    return {
      id: makeGlobalSessionId(this.#hostId, this.providerId, session.id),
      hostId: this.#hostId,
      providerId: this.providerId,
      providerSessionId: session.id,
      title: session.title,
      ...(session.workingDirectory.split(/[\\/]/u).filter(Boolean).at(-1) !== undefined ? { project: session.workingDirectory.split(/[\\/]/u).filter(Boolean).at(-1)! } : {}),
      workingDirectory: session.workingDirectory,
      state: session.state,
      createdAt: session.createdAt,
      lastActivityAt: session.updatedAt,
      preview: session.preview,
      modelId: directModelId(session.endpointId, session.modelId),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      needsApproval: false,
      stale: false,
      nativeMetadata: { endpointId: session.endpointId, walletKind: "user_api" },
    };
  }

  private remoteMessage(session: StoredSession, message: StoredMessage): RemoteMessage {
    const text = message.role === "user" ? stripProviderPromptGuidance(message.text) : message.text;
    const parts: ContentPart[] = [
      ...(message.reasoning === undefined ? [] : [{ type: "reasoning" as const, text: message.reasoning, redacted: false }]),
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...(message.images ?? []).map((image): ContentPart => ({
        type: "image",
        uri: storedImageUri(image),
        ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
        name: image.name,
      })),
      ...(message.audio ?? []).map((audio): ContentPart => ({
        type: "audio",
        uri: storedImageUri(audio),
        mimeType: audio.mimeType ?? "audio/mpeg",
        name: audio.name,
      })),
      ...(message.workflows ?? []).map((workflow): ContentPart => {
        const { promptReference: _promptReference, ...visibleWorkflow } = workflow;
        return { type: "workflow", workflow: visibleWorkflow };
      }),
    ];
    return {
      id: `${this.providerId}/${message.id}`,
      sessionId: makeGlobalSessionId(this.#hostId, this.providerId, session.id),
      providerMessageId: message.providerMessageId,
      role: message.role,
      createdAt: message.createdAt,
      completedAt: message.createdAt,
      parts,
      status: "completed",
      nativeMetadata: { endpointId: session.endpointId },
    };
  }

  private async fetchJson(url: string, apiKey: string | undefined, init: RequestInit, timeoutMs: number, extraHeaders: Readonly<Record<string, string>> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": openCodeClientUserAgent,
          ...extraHeaders,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        const rejectedCredential = response.status === 400
          ? await responseClearlyRejectsCredential(response)
          : false;
        if (response.status !== 400) await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403 || rejectedCredential) {
          throw new ProviderAdapterError(
            this.providerId,
            "AUTH_INVALID_OR_UNAVAILABLE",
            "The API key for this model is invalid or unavailable. Check the key and try again.",
            false,
          );
        }
        if (response.status === 429) {
          throw new ProviderAdapterError(
            this.providerId,
            "USAGE_LIMIT_OR_RATE_LIMIT",
            "This model has reached an API usage limit or is temporarily rate-limited. Check the provider account or try again later.",
            true,
          );
        }
        throw new Error(`API request failed (${response.status})`);
      }
      const text = await boundedResponseText(response, maximumApiResponseBytes);
      return text === "" ? {} : JSON.parse(text) as unknown;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderAdapterError(
          this.providerId,
          "REQUEST_TIMEOUT",
          "The API request timed out before the model finished.",
          true,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async validateApiKey(definition: EndpointDefinition, apiKey: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.#fetch(endpointUrl(definition.baseUrl, "models"), {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": openCodeClientUserAgent, ...openCodeRoutingHeaders(definition), Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) {
        try {
          const text = await boundedResponseText(response, maximumApiResponseBytes);
          const value = text === "" ? undefined : JSON.parse(text) as unknown;
          if (!isObject(value) || !Array.isArray(value.data)) throw new Error("Model catalogue response is invalid");
          return;
        } catch (error) {
          throw new ProviderAdapterError(
            this.providerId,
            "AUTH_VALIDATION_UNAVAILABLE",
            `${definition.name} returned an invalid model catalogue. Nothing was saved.`,
            true,
            { cause: error },
          );
        }
      }
      const rejectedCredential = response.status === 400
        ? await responseClearlyRejectsCredential(response)
        : false;
      if (response.status !== 400) await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403 || rejectedCredential) {
        throw new ProviderAdapterError(this.providerId, "AUTH_INVALID", `${definition.name} did not accept that API key. Nothing was saved.`, false);
      }
      throw new ProviderAdapterError(this.providerId, "AUTH_VALIDATION_UNAVAILABLE", `${definition.name} could not verify the API key right now (${response.status}). Nothing was saved.`, true);
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      const timedOut = controller.signal.aborted;
      throw new ProviderAdapterError(
        this.providerId,
        "AUTH_VALIDATION_UNAVAILABLE",
        `${definition.name} could not be reached to verify the API key${timedOut ? " before the timeout" : ""}. Nothing was saved.`,
        true,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private balanceValue(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error("Balance must be between 0 and 1,000,000 USD");
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private async emit(event: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    await this.#events.emit({ eventId: `direct_event_${++this.#eventCounter}`, providerId: this.providerId, occurredAt: this.#now().toISOString(), ...event });
  }

  private assertActive(): void {
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "PROVIDER_DISPOSED", "Direct API provider has stopped", true);
  }
}

function chatMessage(message: StoredMessage): Record<string, unknown> {
  const content = (message.images?.length || message.audio?.length)
    ? [
        ...(message.text === "" ? [] : [{ type: "text", text: message.text }]),
        ...(message.images ?? []).map((image) => ({ type: "image_url", image_url: { url: storedImageUri(image) } })),
        ...(message.audio ?? []).map((audio) => ({ type: "input_audio", input_audio: inputAudio(audio) })),
      ]
    : message.text;
  return { role: message.role, content };
}

/** Splits incoming attachments by modality and validates audio containers for direct API input_audio blocks. */
function splitDirectAttachments(attachments: readonly MessageAttachment[]): { readonly imageAttachments: readonly StoredAttachment[]; readonly audioAttachments: readonly StoredAttachment[] } {
  const imageAttachments: StoredAttachment[] = [];
  const audioAttachments: StoredAttachment[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType.toLowerCase();
    if (mimeType.startsWith("image/")) {
      imageAttachments.push({ ...attachment });
    } else if (mimeType.startsWith("audio/")) {
      inputAudio(attachment);
      audioAttachments.push({ ...attachment });
    } else {
      throw new Error(`${attachment.name} is not an image or audio attachment`);
    }
  }
  return { imageAttachments, audioAttachments };
}

/** Builds the input_audio payload used by the Responses and Chat Completions APIs. */
function inputAudio(attachment: { readonly mimeType?: string; readonly dataBase64?: string }): { readonly data: string; readonly format: "mp3" | "wav" } {
  if (attachment.dataBase64 === undefined) throw new Error("Direct API audio input is missing its audio data");
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  let format: "mp3" | "wav";
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") format = "mp3";
  else if (mimeType === "audio/wav" || mimeType === "audio/x-wav" || mimeType === "audio/wave") format = "wav";
  else throw new Error("Direct API audio input must be an MP3 or WAV recording");
  return { data: attachment.dataBase64, format };
}

function parseAssistantContent(value: unknown): { readonly text: string; readonly images: readonly StoredAttachment[] } {
  if (typeof value === "string") return { text: value, images: markdownImages(value) };
  if (!Array.isArray(value)) return { text: "", images: [] };
  const text: string[] = [];
  const images: StoredAttachment[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if ((item.type === "text" || item.type === "output_text") && typeof item.text === "string") text.push(item.text);
    const image = isObject(item.image_url) ? item.image_url.url : item.image_url ?? item.url ?? item.b64_json;
    if (typeof image !== "string") continue;
    const parsed = imageFromValue(image, `generated-${images.length + 1}.png`);
    if (parsed !== undefined) images.push(parsed);
  }
  return { text: text.join("\n"), images };
}

function parseResponsesOutput(root: Record<string, unknown>): { readonly text: string; readonly reasoning?: string; readonly images: readonly StoredAttachment[] } {
  const outputText = typeof root.output_text === "string" ? root.output_text : undefined;
  const text: string[] = outputText === undefined ? [] : [outputText];
  const reasoning: string[] = [];
  const images: StoredAttachment[] = outputText === undefined ? [] : [...markdownImages(outputText)];
  for (const output of Array.isArray(root.output) ? root.output : []) {
    if (!isObject(output)) continue;
    if (output.type === "reasoning" && Array.isArray(output.summary)) {
      for (const item of output.summary) if (isObject(item) && typeof item.text === "string") reasoning.push(item.text);
    }
    const content = Array.isArray(output.content) ? output.content : [];
    const parsed = parseAssistantContent(content);
    text.push(parsed.text);
    images.push(...parsed.images);
    const base64 = typeof output.result === "string" ? output.result : typeof output.b64_json === "string" ? output.b64_json : undefined;
    if (base64 !== undefined) {
      const parsedImage = imageFromValue(`data:image/png;base64,${base64}`, `generated-${images.length + 1}.png`);
      if (parsedImage !== undefined) images.push(parsedImage);
    }
  }
  return { text: text.filter(Boolean).join("\n"), ...(reasoning.length ? { reasoning: reasoning.join("\n") } : {}), images };
}

function imageFromValue(value: string, name: string): StoredAttachment | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,\s]+(?:=[^;,\s]*)?)*;base64,([a-z0-9+/_-]*={0,2})$/iu.exec(value);
  if (match !== null) {
    const mimeType = match[1];
    const dataBase64 = match[2];
    if (mimeType === undefined || dataBase64 === undefined) return undefined;
    if (dataBase64.length > Math.ceil(maximumOutputImageBytes / 3) * 4 + 4) return undefined;
    const byteLength = Buffer.from(dataBase64, "base64").byteLength;
    if (byteLength <= 0 || byteLength > maximumOutputImageBytes) return undefined;
    return { name, mimeType, dataBase64, byteLength };
  }
  try {
    const url = new URL(value);
    const loopback = isLoopbackHostname(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
    return { name, uri: url.toString() };
  } catch {
    return undefined;
  }
}

function storedImageUri(image: StoredAttachment): string {
  if (image.uri !== undefined) return image.uri;
  if (image.mimeType !== undefined && image.dataBase64 !== undefined) return `data:${image.mimeType};base64,${image.dataBase64}`;
  throw new Error("Stored image has no usable URI or image data");
}

function markdownImages(value: string): readonly StoredAttachment[] {
  const images: StoredAttachment[] = [];
  for (const match of value.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/giu)) {
    const uri = match[2];
    if (uri === undefined) continue;
    const parsed = imageFromValue(uri, match[1]?.trim() || `generated-${images.length + 1}`);
    if (parsed !== undefined && !images.some((image) => image.uri === parsed.uri)) images.push(parsed);
  }
  return images;
}

function parseToolArguments(value: unknown): JsonObject {
  if (value === undefined || value === null || value === "") return {};
  const parsed = typeof value === "string"
    ? (() => {
        if (Buffer.byteLength(value, "utf8") > 256 * 1024) throw new Error("Tool arguments exceed the 256 KiB limit");
        return JSON.parse(value) as unknown;
      })()
    : value;
  if (!isObject(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as JsonObject;
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const reported = Number(response.headers.get("content-length"));
  if (Number.isFinite(reported) && reported > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`API response exceeds the ${maximumBytes}-byte limit`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`API response exceeds the ${maximumBytes}-byte limit`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function responseClearlyRejectsCredential(response: Response): Promise<boolean> {
  try {
    const text = await boundedResponseText(response, maximumErrorResponseBytes);
    return responseErrorTextCandidates(text).some(clearlyRejectsCredential);
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
}

function responseErrorTextCandidates(text: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return [text];
  }
  if (typeof value === "string") return [value];
  if (!isObject(value)) return [text];
  const candidates: string[] = [];
  const appendKnownFields = (record: Record<string, unknown>): void => {
    for (const field of ["message", "detail", "code", "type", "reason", "status"] as const) {
      if (typeof record[field] === "string") candidates.push(record[field]);
    }
  };
  const error = value.error;
  if (typeof error === "string") candidates.push(error);
  else if (isObject(error)) appendKnownFields(error);
  appendKnownFields(value);
  return candidates.length > 0 ? candidates : [text];
}

function clearlyRejectsCredential(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  const rejectedBeforeCredential = /(?:^|[^a-z0-9])(?:invalid|incorrect|malformed|expired|revoked|rejected|denied|unauthori[sz]ed|not accepted|not valid|failed)(?:\s+(?:provided|supplied))?\s+(?:api\s*keys?(?:\s+credentials?)?|credentials?|auth(?:entication|ori[sz]ation)?(?:\s+tokens?)?)(?=$|[^a-z0-9])/u;
  const credentialBeforeRejection = /(?:^|[^a-z0-9])(?:api\s*keys?(?:\s+credentials?)?|credentials?|auth(?:entication|ori[sz]ation)?(?:\s+tokens?)?)(?:\s+(?:provided|supplied))?(?:\s+(?:has(?: been)?|have(?: been)?|is|was|are|were))?\s+(?:invalid|incorrect|malformed|expired|revoked|rejected|denied|unauthori[sz]ed|not accepted|not valid|failed)(?=$|[^a-z0-9])/u;
  const explicitAuthenticationFailure = /(?:^|[^a-z0-9])(?:failed\s+to\s+auth(?:enticate|ori[sz]e)|auth(?:entication|ori[sz]ation)\s+(?:error|failure))(?=$|[^a-z0-9])/u;
  return rejectedBeforeCredential.test(normalized) ||
    credentialBeforeRejection.test(normalized) ||
    explicitAuthenticationFailure.test(normalized);
}

function parseUsage(value: unknown): SessionTokenUsage {
  const usage = isObject(value) ? value : {};
  const inputTokens = integer(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = integer(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = integer(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const costDetails = isObject(usage.cost) ? usage.cost : {};
  const cost = finiteNumber(usage.cost) ?? finiteNumber(costDetails.total_cost);
  const currency = typeof costDetails.currency === "string" && costDetails.currency.trim() !== "" ? costDetails.currency.trim().toUpperCase() : "USD";
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost !== undefined ? { cost, currency } : {}),
  };
}

function parseResponsesUsage(value: unknown): SessionTokenUsage {
  return parseUsage(value);
}

function mergeUsage(current: SessionTokenUsage, next: SessionTokenUsage): SessionTokenUsage {
  const sum = (left: number | undefined, right: number | undefined): number | undefined => left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const inputTokens = sum(current.inputTokens, next.inputTokens);
  const outputTokens = sum(current.outputTokens, next.outputTokens);
  const totalTokens = sum(current.totalTokens, next.totalTokens);
  const cost = sum(current.cost, next.cost);
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(cost !== undefined ? { cost, currency: next.currency ?? current.currency ?? "USD" } : {}) };
}

function pricedCost(usage: SessionTokenUsage, pricing: Pick<ListedModel, "inputPricePerToken" | "outputPricePerToken">): number | undefined {
  if (pricing.inputPricePerToken === undefined && pricing.outputPricePerToken === undefined) return undefined;
  return (usage.inputTokens ?? 0) * (pricing.inputPricePerToken ?? 0) + (usage.outputTokens ?? 0) * (pricing.outputPricePerToken ?? 0);
}

function isDirectEyesTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-\s]+/gu, "_");
  return normalized === "ask_eyes" || normalized.endsWith("_ask_eyes")
    || normalized === "tethoq_turn_support" || normalized.endsWith("_tethoq_turn_support");
}

function safeDirectEyesToolError(error: unknown): string {
  const normalized = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase().slice(0, 24_000);
  if (/\b(?:429|quota|rate[_ -]?limit|usage[_ -]?limit|resource[_ -]?exhausted|insufficient (?:balance|credit)|billing)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.";
  }
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|api[_ -]?key|credential|auth(?:entication|ori[sz]ation)?)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its API key is missing, invalid, or no longer accepted. Update the key in EYES settings and try again.";
  }
  if (/\b(?:timed? out|timeout|deadline)\b/u.test(normalized)) {
    return "EYES did not finish inspecting the image. Try again or choose another EYES model.";
  }
  if (/\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b/u.test(normalized)) {
    return "EYES was interrupted before it finished inspecting the image. Try again when you are ready.";
  }
  return "EYES could not inspect the image. Try again or choose another EYES model.";
}

function dedupeModels(models: readonly ListedModel[]): readonly ListedModel[] {
  const seen = new Set<string>();
  return models.filter((entry) => seen.has(entry.model.id) ? false : (seen.add(entry.model.id), true));
}

function localTranscriptSummary(messages: readonly StoredMessage[]): string {
  const lines = messages.map((message) => `${message.role}: ${message.text.replace(/\s+/gu, " ").trim()}`).filter((line) => !line.endsWith(": "));
  const selected = lines.length <= 12 ? lines : [...lines.slice(0, 4), ...lines.slice(-8)];
  return selected.join("\n").split(/\s+/u).slice(0, 1_000).join(" ");
}
