import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
    const models = await adapter.listModels();
    assert.ok(models.some((model) => model.id === "openai::gpt-5.6-sol"));
    assert.ok(models.some((model) => model.id === "zai::glm-5.2"));
    assert.ok(models.some((model) => model.id === "crof::glm-5.2"));
    assert.ok(models.some((model) => model.id === "google::gemini-3.6-flash"));
    assert.deepEqual(models.find((model) => model.id === "google::gemini-3.6-flash")?.inputModalities, ["text", "image"]);
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath, encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
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

test("CrofAI wallet uses the documented provider credit endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-crof-"));
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://crof.ai/usage_api/") return new Response(JSON.stringify({ usable_requests: 12, credits: 7.25 }), { status: 200 });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: async () => new Response(JSON.stringify({ data: [] })) });
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: async () => { throw new Error("No network expected"); } });
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath, encryptionSecret: "test-secret", environment: {}, fetch: async () => { throw new Error("No network expected"); } });
    assert.equal((await adapter.listSessions()).sessions[0]?.state, "failed");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct sessions honor per-turn endpoint model selection and provider-reported cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-switch-"));
  const requested: string[] = [];
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Switched endpoint" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: { total_cost: 0.04, currency: "usd" } },
      }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["openai", "test-key"].join("-") });
    await adapter.configureWallet({ endpointId: "zai", apiKey: ["zai", "test-key"].join("-") });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-terra" });
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolveCompleted(); });
    await adapter.sendMessage(session.providerSessionId, { requestId: "switch-request", content: "Use GLM", modelId: "zai::glm-5.2" });
    await completed;
    assert.equal((await adapter.getSession(session.providerSessionId)).modelId, "zai::glm-5.2");
    assert.equal((await adapter.getSessionContext(session.providerSessionId)).usage.cost, 0.04);
    assert.equal((await adapter.getWalletStatus("zai::glm-5.2")).spent, 0.04);
    assert.ok(requested.includes("https://api.z.ai/api/paas/v4/chat/completions"));
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
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch });
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
    await adapter.sendMessage(session.providerSessionId, { requestId: "tool-request", content: "Inspect the browser" });
    await completed;
    assert.deepEqual(executions, [{ tool: "browser_capture", input: { question: "What is visible?" } }]);
    assert.deepEqual(events.filter((type) => type.startsWith("tool.")), ["tool.started", "tool.completed"]);
    assert.equal(requestBodies.length, 2);
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
