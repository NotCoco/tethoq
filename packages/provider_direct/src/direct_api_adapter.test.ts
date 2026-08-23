import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DirectApiProviderAdapter } from "./direct_api_adapter.js";

test("direct API catalog exposes wallet/key metadata without contacting paid models", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-catalog-"));
  try {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async (input) => {
      fetchCalls += 1;
      throw new Error(`Unexpected URL ${String(input)}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    const models = await adapter.listModels();
    assert.ok(models.some((model) => model.id === "openai::gpt-5.6-sol"));
    assert.ok(models.some((model) => model.id === "zai::glm-5.2"));
    assert.ok(models.some((model) => model.id === "crof::glm-5.2"));
    assert.ok(models.some((model) => model.id === "google::gemini-3.6-flash"));
    // Gemini genuinely hears audio and sits on the chat-completions route that
    // can carry it.
    assert.deepEqual(models.find((model) => model.id === "google::gemini-3.6-flash")?.inputModalities, ["text", "image", "audio"]);
    // GPT-5.6 Sol accepts text and image input. MP3 dictation must use EARS
    // rather than being inferred from the model's name or endpoint.
    assert.deepEqual(models.find((model) => model.id === "openai::gpt-5.6-sol")?.inputModalities, ["text", "image"]);
    assert.deepEqual(models.find((model) => model.id === "vercel::openai/gpt-5.6-sol")?.inputModalities, ["text", "image"]);
    assert.equal(models.find((model) => model.id === "google::gemini-3.6-flash")?.nativeMetadata.contextWindow, 1_048_576);
    assert.equal(models.find((model) => model.id === "zai::glm-5.2")?.nativeMetadata.apiKeyConfigured, false);
    const wallet = await adapter.getWalletStatus("zai::glm-5.2");
    assert.equal(wallet.kind, "user_api");
    assert.equal(wallet.apiKeyConfigured, false);
    assert.match(wallet.caution ?? "", /API key/i);
    assert.ok(wallet.availableEndpoints?.some((endpoint) => endpoint.id === "openrouter"));
    assert.equal(wallet.availableEndpoints?.find((endpoint) => endpoint.id === "google")?.apiKeyLabel, "GOOGLE_API_KEY / GEMINI_API_KEY");
    assert.equal(fetchCalls, 0, "initial catalog loading must not probe third-party APIs before a key is configured");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static OpenAI capabilities cannot be widened by stale model discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-capabilities-"));
  try {
    const fakeFetch: typeof fetch = async (input) => {
      assert.equal(String(input), "https://api.openai.com/v1/models");
      return new Response(JSON.stringify({
        data: [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          architecture: { input_modalities: ["text", "image", "audio"] },
        }],
      }), { status: 200 });
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { OPENAI_API_KEY: "fixture-key" },
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    const models = await adapter.listModels();
    assert.deepEqual(
      models.find((model) => model.id === "openai::gpt-5.6-sol")?.inputModalities,
      ["text", "image"],
    );
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Google Gemini uses the documented OpenAI-compatible chat route with a user API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-gemini-"));
  const requests: Array<{ readonly url: string; readonly headers: Headers; readonly body?: Record<string, unknown> }> = [];
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, headers: new Headers(init?.headers), ...(body === undefined ? {} : { body }) });
      if (url === "https://generativelanguage.googleapis.com/v1beta/openai/models") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url === "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Gemini direct answer" } }],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const apiKey = ["gemini", "fixture", "key"].join("-");
    const statePath = join(root, "wallet.json");
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath,
      encryptionSecret: "test-secret",
      environment: { GEMINI_API_KEY: apiKey },
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    assert.equal((await adapter.getWalletStatus("google::gemini-3.6-flash")).apiKeyConfigured, true);
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "google::gemini-3.6-flash" });
    let terminalEvent: string | undefined;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => {
      if (event.type === "agent.completed" || event.type === "agent.error") {
        terminalEvent = event.type;
        resolveTerminal();
      }
    });
    await adapter.sendMessage(session.providerSessionId, {
      requestId: "gemini-request",
      content: "Describe this image",
      attachments: [{ name: "sample.png", mimeType: "image/png", dataBase64: "aGVsbG8=", byteLength: 5 }],
    });
    await terminal;

    assert.equal(terminalEvent, "agent.completed");
    const completion = requests.find((request) => request.url.endsWith("/chat/completions"));
    assert.ok(completion);
    assert.equal(completion.headers.get("authorization"), `Bearer ${apiKey}`);
    assert.equal(completion.body?.model, "gemini-3.6-flash");
    assert.match(JSON.stringify(completion.body?.messages), /data:image\/png;base64,aGVsbG8=/u);
    assert.equal((await adapter.getSessionContext(session.providerSessionId)).contextWindowTokens, 1_048_576);
    assert.equal((await adapter.getSessionContext(session.providerSessionId)).usage.totalTokens, 15);
    assert.equal((await adapter.getMessages(session.providerSessionId)).at(-1)?.parts.some((part) => part.type === "text" && part.text === "Gemini direct answer"), true);
    assert.equal((await readFile(statePath, "utf8")).includes(apiKey), false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API key is encrypted and Responses usage updates the local wallet", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-send-"));
  const statePath = join(root, "wallet.json");
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.endsWith("/responses")) return new Response(JSON.stringify({
      output_text: "Direct answer",
      output: [],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }), { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath, encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "never-plaintext"].join("-"), setBalance: 20 });
    assert.equal((await adapter.getWalletStatus("openai::gpt-5.6-sol")).apiKeyConfigured, true);
    assert.equal((await readFile(statePath, "utf8")).includes("sk-test-never-plaintext"), false);

    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-sol" });
    const completed = new Promise<void>(async (resolve) => {
      await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolve(); });
    });
    await adapter.sendMessage(session.providerSessionId, {
      requestId: "request-1",
      content: "Describe this",
      attachments: [{ name: "shot.png", mimeType: "image/png", dataBase64: "aGVsbG8=", byteLength: 5 }],
    });
    await completed;
    const messages = await adapter.getMessages(session.providerSessionId);
    assert.equal(messages.at(-1)?.parts.some((part) => part.type === "text" && part.text === "Direct answer"), true);
    assert.equal(requests.some((request) => request.url.endsWith("/responses")), true);
    const context = await adapter.getSessionContext(session.providerSessionId);
    assert.equal(context.usage.totalTokens, 120);
    assert.ok((context.usage.cost ?? 0) > 0);
    assert.ok(((await adapter.getWalletStatus("openai::gpt-5.6-sol")).spent ?? 0) > 0);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API errors do not expose upstream response content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-error-"));
  const upstreamSecret = ["provider", "credential", "fixture"].join("-");
  const upstreamPrompt = "confidential provider prompt fixture";
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/responses")) {
        return new Response(JSON.stringify({ error: { message: `${upstreamSecret}: ${upstreamPrompt}` } }), { status: 429 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "error-fixture"].join("-") });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-sol" });
    let errorMessage: string | undefined;
    let resolveError!: () => void;
    const errored = new Promise<void>((resolve) => { resolveError = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => {
      if (event.type === "agent.error") {
        errorMessage = typeof event.payload.message === "string" ? event.payload.message : undefined;
        resolveError();
      }
    });

    await adapter.sendMessage(session.providerSessionId, { requestId: "error-request", content: "Trigger a safe error" });
    await errored;

    assert.equal(errorMessage, "API request failed (429)");
    assert.doesNotMatch(errorMessage ?? "", new RegExp(upstreamSecret, "u"));
    assert.doesNotMatch(errorMessage ?? "", new RegExp(upstreamPrompt, "u"));
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CrofAI wallet uses the documented provider credit endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-crof-"));
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://crof.ai/usage_api/") return new Response(JSON.stringify({ usable_requests: 12, credits: 7.25 }), { status: 200 });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "crof", apiKey: "crof-test-key" });
    const wallet = await adapter.getWalletStatus("crof::glm-5.2");
    assert.equal(wallet.balance, 7.25);
    assert.match(wallet.detail, /provider credit/i);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Perplexity uses its Agent API catalog after credential setup and ignores ambiguous discovered pricing units", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-perplexity-"));
  const requested: string[] = [];
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://api.perplexity.ai/v1/models") {
        return new Response(JSON.stringify({ data: [{
          id: "openai/example-model",
          name: "Example model",
          pricing: { input: 9, output: 27 },
        }] }), { status: 200 });
      }
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "perplexity", apiKey: ["pplx", "fixture", "key"].join("-") });
    const models = await adapter.listModels();
    const model = models.find((entry) => entry.id === "perplexity::openai/example-model");
    assert.ok(model);
    assert.equal(model.nativeMetadata.protocol, "responses");
    assert.equal(model.nativeMetadata.pricing, undefined);
    assert.ok(requested.includes("https://api.perplexity.ai/v1/models"));
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing a custom endpoint origin clears its saved credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-custom-origin-"));
  try {
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: async () => new Response(JSON.stringify({ data: [] })), homeDirectory: join(root, "home") });
    await adapter.configureWallet({
      endpointId: "private-host",
      apiKey: ["private", "fixture", "key"].join("-"),
      customEndpoint: { id: "private-host", name: "Private host", baseUrl: "https://one.example/v1", protocol: "responses", modelIds: ["model-a"] },
    });
    assert.equal((await adapter.getWalletStatus(undefined, "private-host")).apiKeyConfigured, true);
    await adapter.configureWallet({
      endpointId: "private-host",
      customEndpoint: { id: "private-host", name: "Private host", baseUrl: "https://two.example/v1", protocol: "responses", modelIds: ["model-a"] },
    });
    assert.equal((await adapter.getWalletStatus(undefined, "private-host")).apiKeyConfigured, false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom endpoints accept IPv6 loopback HTTP without treating remote HTTP as safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-loopback-"));
  try {
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: async () => { throw new Error("No network expected"); }, homeDirectory: join(root, "home") });
    const local = await adapter.configureWallet({
      endpointId: "local-v6",
      customEndpoint: { id: "local-v6", name: "Local IPv6", baseUrl: "http://[::1]:11434/v1", protocol: "chat_completions", modelIds: ["local-model"] },
    });
    assert.equal(local.endpointName, "Local IPv6");
    await assert.rejects(adapter.configureWallet({
      endpointId: "remote-http",
      customEndpoint: { id: "remote-http", name: "Remote HTTP", baseUrl: "http://example.com/v1", protocol: "responses" },
    }), /must use HTTPS/);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted working direct sessions recover as failed after process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-recover-"));
  const statePath = join(root, "wallet.json");
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      endpoints: {},
      sessions: [{
        id: "interrupted-session",
        title: "Interrupted request",
        workingDirectory: "C:\\workspace",
        endpointId: "openai",
        modelId: "gpt-5.6-terra",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:01:00.000Z",
        preview: "Request in progress",
        state: "working",
        usage: {},
        messages: [],
      }],
    }), "utf8");
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath, encryptionSecret: "test-secret", environment: {}, fetch: async () => { throw new Error("No network expected"); }, homeDirectory: join(root, "home") });
    assert.equal((await adapter.listSessions()).sessions[0]?.state, "failed");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct sessions honor per-turn endpoint model selection and provider-reported cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-switch-"));
  const requested: string[] = [];
  const requestBodies: Record<string, unknown>[] = [];
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Switched endpoint" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: { total_cost: 0.04, currency: "usd" } },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["openai", "test-key"].join("-") });
    await adapter.configureWallet({ endpointId: "zai", apiKey: ["zai", "test-key"].join("-") });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-terra" });
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolveCompleted(); });
    await adapter.sendMessage(session.providerSessionId, { requestId: "switch-request", content: "Use GLM", modelId: "zai::glm-5.2", reasoningEffort: "high" });
    await completed;
    assert.equal((await adapter.getSession(session.providerSessionId)).modelId, "zai::glm-5.2");
    assert.equal((await adapter.getSessionContext(session.providerSessionId)).usage.cost, 0.04);
    assert.equal((await adapter.getWalletStatus("zai::glm-5.2")).spent, 0.04);
    assert.ok(requested.includes("https://api.z.ai/api/paas/v4/chat/completions"));
    assert.equal(requestBodies[0]?.model, "glm-5.2");
    assert.equal(requestBodies[0]?.reasoning_effort, "high");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Responses models can use browser tools and expose inline image output", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-tools-"));
  const requestBodies: Record<string, unknown>[] = [];
  let responseCalls = 0;
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (!url.endsWith("/responses")) throw new Error(`Unexpected URL ${url}`);
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      responseCalls += 1;
      return new Response(JSON.stringify(responseCalls === 1 ? {
        output: [{ type: "function_call", call_id: "call-browser", name: "browser_capture", arguments: "{\"question\":\"What is visible?\"}" }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      } : {
        output_text: "Captured result ![chart](https://example.com/chart.png)",
        output: [],
        usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
      }), { status: 200 });
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    const executions: Array<{ readonly tool: string; readonly input: Record<string, unknown> }> = [];
    adapter.configureClientTooling({
      definitions: [{ name: "browser_capture", description: "Capture the browser", inputSchema: { type: "object" } }],
      execute: async (_providerId, _providerSessionId, tool, input) => {
        executions.push({ tool, input });
        return { observation: "A chart is visible" };
      },
      mcpServer: () => ({ name: "unused", command: "node", args: [], env: {} }),
    });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "tools-key"].join("-"), setBalance: 1 });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-terra" });
    const events: string[] = [];
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => {
      events.push(event.type);
      if (event.type === "agent.completed") resolveCompleted();
    });
    await adapter.sendMessage(session.providerSessionId, { requestId: "tool-request", content: "Inspect the browser", reasoningEffort: "xhigh" });
    await completed;
    assert.deepEqual(executions, [{ tool: "browser_capture", input: { question: "What is visible?" } }]);
    assert.deepEqual(events.filter((type) => type.startsWith("tool.")), ["tool.started", "tool.completed"]);
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies[0]?.reasoning, { effort: "xhigh" });
    assert.deepEqual(requestBodies[1]?.reasoning, { effort: "xhigh" });
    assert.match(JSON.stringify(requestBodies[1]), /function_call_output/);
    const messages = await adapter.getMessages(session.providerSessionId);
    assert.equal(messages.at(-1)?.parts.some((part) => part.type === "image" && part.uri === "https://example.com/chart.png"), true);
    const wallet = await adapter.getWalletStatus("openai::gpt-5.6-terra");
    assert.ok((wallet.balance ?? 1) < 1);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API discovery surfaces opencode providers with api credentials without duplicating static endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-opencode-"));
  const statePath = join(root, "wallet.json");
  const requests: Array<{ readonly url: string; readonly authorization?: string | null }> = [];
  try {
    const home = join(root, "home");
    const authPath = join(home, ".local", "share", "opencode", "auth.json");
    const modelsPath = join(home, ".cache", "opencode", "models.json");
    await mkdir(dirname(authPath), { recursive: true });
    await mkdir(dirname(modelsPath), { recursive: true });
    await writeFile(authPath, JSON.stringify({
      meta: { type: "api", key: "meta-fixture-key" },
      oauthOnly: { type: "oauth", key: "oauth-fixture-key" },
      unresolved: { type: "api", key: "unresolved-fixture-key" },
      openai: { type: "api", key: "openai-fixture-key" },
    }), "utf8");
    await writeFile(modelsPath, JSON.stringify({
      meta: {
        id: "meta",
        name: "Meta AI",
        api: "https://api.metis.ai/openai/v1",
        models: { "llama-4-maverick": { id: "llama-4-maverick", name: "Llama 4 Maverick" } },
      },
      openai: { id: "openai", name: "OpenAI", api: "https://api.openai.com/v1", models: {} },
    }), "utf8");
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Meta direct answer" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath,
      encryptionSecret: "test-secret",
      environment: {},
      fetch: fakeFetch,
      homeDirectory: home,
    });
    const models = await adapter.listModels();
    const meta = models.find((model) => model.id === "meta::llama-4-maverick");
    assert.ok(meta);
    assert.equal(meta.nativeMetadata.apiKeyConfigured, true);
    assert.equal(meta.nativeMetadata.sourceProviderName, "Meta AI");
    assert.equal(meta.nativeMetadata.apiKeyLabel, "opencode 'meta' key");
    // OAuth-style credentials and providers without a resolvable base URL never appear.
    assert.equal(models.some((model) => model.id.startsWith("oauthOnly::")), false);
    assert.equal(models.some((model) => model.id.startsWith("unresolved::")), false);
    // A provider already present statically keeps its single static endpoint.
    assert.equal(models.filter((model) => model.id.startsWith("openai::")).length, 3);
    assert.equal(models.filter((model) => model.id.startsWith("meta::")).length, 1);

    const wallet = await adapter.getWalletStatus(undefined, "meta");
    assert.equal(wallet.apiKeyConfigured, true);
    assert.equal(wallet.availableEndpoints?.filter((endpoint) => endpoint.id === "meta").length, 1);

    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "meta::llama-4-maverick" });
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolveCompleted(); });
    await adapter.sendMessage(session.providerSessionId, { requestId: "meta-request", content: "Hello meta" });
    await completed;
    assert.equal(requests.some((request) => request.url === "https://api.metis.ai/openai/v1/chat/completions" && request.authorization === "Bearer meta-fixture-key"), true);
    // The discovered credential is used in memory only and never persisted.
    assert.equal((await readFile(statePath, "utf8")).includes("meta-fixture-key"), false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opencode discovery tolerates missing or malformed credential files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-opencode-broken-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async () => { throw new Error("No network expected"); },
      homeDirectory: join(root, "home"),
    });
    assert.equal((await adapter.listModels()).some((model) => model.id.startsWith("meta::")), false);
    await adapter.dispose();

    const home = join(root, "home");
    const authPath = join(home, ".local", "share", "opencode", "auth.json");
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, "{ not valid json", "utf8");
    const broken = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet-broken.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async () => { throw new Error("No network expected"); },
      homeDirectory: home,
    });
    assert.equal((await broken.listModels()).some((model) => model.id.startsWith("meta::")), false);
    assert.equal((await broken.getAuthStatus()).authenticated, false);
    await broken.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct audio dictation is forwarded as input_audio content blocks to the Responses API", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-audio-responses-"));
  const requests: Array<{ readonly url: string; readonly body?: Record<string, unknown> }> = [];
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, ...(body === undefined ? {} : { body }) });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/responses")) return new Response(JSON.stringify({
        output_text: "I heard you",
        output: [],
        usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
      }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "openai", apiKey: "sk-test-audio-key" });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-sol" });
    const completed = new Promise<void>(async (resolve) => {
      await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolve(); });
    });
    await adapter.sendMessage(session.providerSessionId, {
      requestId: "audio-request",
      content: "Listen to this",
      attachments: [{ name: "dictation.mp3", mimeType: "audio/mpeg", dataBase64: "aGVsbG8=", byteLength: 5 }],
    });
    await completed;
    const call = requests.find((request) => request.url.endsWith("/responses"));
    assert.ok(call);
    assert.match(JSON.stringify(call.body?.input), /"type":"input_audio"/u);
    assert.match(JSON.stringify(call.body?.input), /"format":"mp3"/u);
    assert.match(JSON.stringify(call.body?.input), /"data":"aGVsbG8="/u);
    assert.equal(JSON.stringify(call.body?.input).includes('"input_image"'), false);
    const parts = (await adapter.getMessages(session.providerSessionId)).at(0)?.parts ?? [];
    const audioPart = parts.find((part) => part.type === "audio");
    assert.deepEqual(audioPart, { type: "audio", uri: "data:audio/mpeg;base64,aGVsbG8=", mimeType: "audio/mpeg", name: "dictation.mp3" });
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini receives WAV dictation as input_audio parts on its OpenAI-compatible route", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-audio-gemini-"));
  const requests: Array<{ readonly url: string; readonly body?: Record<string, unknown> }> = [];
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, ...(body === undefined ? {} : { body }) });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Gemini heard you" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    await adapter.configureWallet({ endpointId: "google", apiKey: "gemini-test-audio-key" });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "google::gemini-3.6-flash" });
    const completed = new Promise<void>(async (resolve) => {
      await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolve(); });
    });
    await adapter.sendMessage(session.providerSessionId, {
      requestId: "audio-request",
      content: "Listen to this",
      attachments: [{ name: "recording.wav", mimeType: "audio/wav", dataBase64: "aGVsbG8=", byteLength: 5 }],
    });
    await completed;
    const call = requests.find((request) => request.url.endsWith("/chat/completions"));
    assert.ok(call);
    assert.match(JSON.stringify(call.body?.messages), /"type":"input_audio"/u);
    assert.match(JSON.stringify(call.body?.messages), /"format":"wav"/u);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API rejects audio containers that are not MP3 or WAV", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-audio-reject-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error(`Unexpected URL ${url}`);
      },
      homeDirectory: join(root, "home"),
    });
    await adapter.configureWallet({ endpointId: "openai", apiKey: "sk-test-audio-key" });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-sol" });
    await assert.rejects(
      adapter.sendMessage(session.providerSessionId, {
        requestId: "audio-request",
        content: "Listen to this",
        attachments: [{ name: "clip.ogg", mimeType: "audio/ogg", dataBase64: "aGVsbG8=", byteLength: 5 }],
      }),
      /MP3 or WAV/iu,
    );
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
