import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ProviderEvent } from "../../provider_contract/src/index.js";
import { DirectApiProviderAdapter } from "./direct_api_adapter.js";
import { hiddenProviderControlContent } from "../../provider_contract/src/index.js";

test("direct API Continue hides only the control message after reloading persisted history", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-continue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let count = 0;
  const options = { hostId: "continue", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, homeDirectory: join(root, "home"),
    fetch: (async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
      return new Response(JSON.stringify({ output_text: `Answer ${++count}`, output: [] }));
    }) as typeof fetch };
  const adapter = new DirectApiProviderAdapter(options);
  t.after(() => adapter.dispose());
  await adapter.configureWallet({ endpointId: "openai", apiKey: "test-fixture" });
  const session = await adapter.createSession({ workingDirectory: root, modelId: "openai::gpt-5.6-sol", title: "Original task" });
  for (const [index, content] of [hiddenProviderControlContent("continue"), "continue"].entries()) {
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const subscription = await adapter.subscribe(session.providerSessionId, event => { if (event.type === "agent.completed") done(); });
    await adapter.sendMessage(session.providerSessionId, { requestId: `request-${index}`, content, ...(index === 0 ? { developerInstructions: "Resume the interrupted task." } : {}) });
    await completed;
    await subscription.unsubscribe();
  }
  await adapter.dispose();
  const restored = new DirectApiProviderAdapter(options);
  t.after(() => restored.dispose());
  const messages = await restored.getMessages(session.providerSessionId);
  assert.deepEqual(messages.map(m => [m.role, m.parts.flatMap(p => p.type === "text" ? [p.text] : [])]), [
    ["user", []], ["assistant", ["Answer 1"]], ["user", ["continue"]], ["assistant", ["Answer 2"]],
  ]);
  assert.equal((await restored.getSession(session.providerSessionId)).preview?.includes("hidden_control") ?? false, false);
});

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
    assert.ok(models.some((model) => model.id === "xai::grok-4.6"));
    // Gemini genuinely hears audio and sits on the chat-completions route that
    // can carry it.
    assert.deepEqual(models.find((model) => model.id === "google::gemini-3.6-flash")?.inputModalities, ["text", "image", "audio"]);
    assert.deepEqual(models.find((model) => model.id === "xai::grok-4.6")?.inputModalities, ["text", "image"]);
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
    assert.equal(wallet.availableEndpoints?.find((endpoint) => endpoint.id === "xai")?.apiKeyLabel, "XAI_API_KEY / GROK_API_KEY");
    assert.equal(fetchCalls, 0, "initial catalog loading must not probe third-party APIs before a key is configured");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct wallet detail reports configuration without implying that a route is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-wallet-detail-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async () => { throw new Error("No network expected"); },
      homeDirectory: join(root, "home"),
    });

    const missing = await adapter.getWalletStatus("openai::gpt-5.6-sol");
    assert.equal(missing.detail, "OpenAI API key is required and not configured");
    assert.equal(missing.caution, "Add the OpenAI API key before using this model");
    assert.equal(missing.apiKeyConfigured, false);
    assert.doesNotMatch(`${missing.detail} ${missing.caution}`, /API API|being used|\bcap\b/iu);

    await adapter.configureWallet({ endpointId: "openai", apiKey: "test-wallet" });
    const configured = await adapter.getWalletStatus("openai::gpt-5.6-sol");
    assert.equal(configured.detail, "OpenAI API key is configured");
    assert.equal(configured.apiKeyConfigured, true);
    assert.doesNotMatch(configured.detail, /API API|being used|\bcap\b/iu);

    await adapter.configureWallet({ endpointId: "openai", setBalance: 25 });
    const capped = await adapter.getWalletStatus("openai::gpt-5.6-sol");
    assert.equal(capped.detail, "OpenAI API key is configured with a local spend cap");
    assert.equal(capped.apiKeyConfigured, true);
    assert.doesNotMatch(capped.detail, /API API|being used/iu);

    await adapter.configureWallet({ endpointId: "openai", clearBalance: true });
    const cleared = await adapter.getWalletStatus("openai::gpt-5.6-sol");
    assert.equal(cleared.balance, undefined);
    assert.equal(cleared.detail, "OpenAI API key is configured");
    await assert.rejects(
      adapter.configureWallet({ endpointId: "openai", clearBalance: true, setBalance: 0 }),
      /clearBalance cannot be combined/iu,
    );
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a validated saved EYES key takes precedence over an inherited key", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-key-replacement-"));
  try {
    const authorizations: (string | null)[] = [];
    const options = {
      hostId: "host-test", statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret", environment: { GROK_API_KEY: "old-fixture-key" },
      homeDirectory: join(root, "home"),
      fetch: (async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }));
      }) as typeof fetch,
    };
    const adapter = new DirectApiProviderAdapter(options);
    await adapter.configureWallet({ endpointId: "xai", apiKey: "test-replaced", validateApiKey: true });
    const models = await adapter.listModels();
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyVerified, true);
    await adapter.dispose();
    const restarted = new DirectApiProviderAdapter(options);
    await restarted.listModels();
    await restarted.dispose();
    assert.ok(authorizations.length >= 2);
    assert.ok(authorizations.every((value) => value === "Bearer test-replaced"));
    assert.ok(!(await readFile(options.statePath, "utf8")).includes("test-replaced"));
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

test("xAI EYES accepts the existing GROK_API_KEY alias without copying the secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-grok-alias-"));
  const apiKey = ["grok", "fixture", "credential"].join("-");
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      assert.equal(String(input), "https://api.x.ai/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { GROK_API_KEY: apiKey },
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    const models = await adapter.listModels();
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyConfigured, true);
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyVerified, false);
    assert.equal((await adapter.getWalletStatus("xai::grok-4.6")).apiKeyLabel, "XAI_API_KEY / GROK_API_KEY");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xAI EYES verifies the static seed only when its exact model ID is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-grok-present-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { GROK_API_KEY: ["grok", "present", "fixture", "key"].join("-") },
      fetch: async () => new Response(JSON.stringify({ data: [
        { id: "grok-4.6", name: "Discovered Grok", architecture: { input_modalities: ["text"] } },
        { id: "grok-preview", architecture: { input_modalities: ["image"] } },
      ] }), { status: 200 }),
      homeDirectory: join(root, "home"),
    });

    const models = await adapter.listModels();
    const seed = models.find((model) => model.id === "xai::grok-4.6");
    assert.equal(seed?.nativeMetadata.apiKeyVerified, true);
    assert.equal(seed?.nativeMetadata.contextWindow, 500_000);
    assert.deepEqual(seed?.inputModalities, ["text", "image"]);
    assert.equal(models.find((model) => model.id === "xai::grok-preview")?.nativeMetadata.apiKeyVerified, true);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xAI EYES does not verify a static seed from a near-match model ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-grok-near-match-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { GROK_API_KEY: ["grok", "near-match", "fixture", "key"].join("-") },
      fetch: async () => new Response(JSON.stringify({ data: [
        { id: "grok-4.6-preview", architecture: { input_modalities: ["image"] } },
      ] }), { status: 200 }),
      homeDirectory: join(root, "home"),
    });

    const models = await adapter.listModels();
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyVerified, false);
    assert.equal(models.find((model) => model.id === "xai::grok-4.6-preview")?.nativeMetadata.apiKeyVerified, true);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed direct model discovery does not advertise EYES as verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-eyes-unverified-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { GROK_API_KEY: "fixture-key" },
      fetch: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      homeDirectory: join(root, "home"),
    });

    const model = (await adapter.listModels()).find((candidate) => candidate.id === "xai::grok-4.6");
    assert.equal(model?.nativeMetadata.apiKeyConfigured, true);
    assert.equal(model?.nativeMetadata.apiKeyVerified, false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API classifies its own request abort as a timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-timeout-"));
  try {
    let resolveRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { resolveRequestStarted = resolve; });
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }), { status: 200 });
      resolveRequestStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("request signal is missing");
        signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: { GROK_API_KEY: "fixture-key" },
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    const session = await adapter.createSession({ workingDirectory: root, modelId: "xai::grok-4.6" });
    let timeoutMessage: string | undefined;
    let resolveTimeout!: () => void;
    const timedOut = new Promise<void>((resolve) => { resolveTimeout = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => {
      if (event.type !== "agent.error") return;
      timeoutMessage = typeof event.payload.message === "string" ? event.payload.message : undefined;
      resolveTimeout();
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const send = await adapter.sendMessage(session.providerSessionId, { requestId: "timeout-request", content: "Inspect" });
    assert.equal(send.accepted, true);
    await requestStarted;
    t.mock.timers.tick(180_001);

    await timedOut;
    assert.match(timeoutMessage ?? "", /timed out before the model finished/u);
    assert.equal((await adapter.getSession(session.providerSessionId)).state, "failed");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EYES API key validation rejects an invalid key without replacing the saved credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-eyes-key-validation-"));
  const acceptedKey = "grok-valid-fixture-key";
  const rejectedKey = "grok-invalid-fixture-key";
  const authorizations: string[] = [];
  try {
    const fakeFetch: typeof fetch = async (input, init) => {
      assert.equal(String(input), "https://api.x.ai/v1/models");
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization === `Bearer ${rejectedKey}`) {
        return new Response(JSON.stringify({
          error: { message: "The supplied API key credential is incorrect (sanitized-auth-body-marker)." },
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }), { status: 200 });
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    await adapter.configureWallet({ endpointId: "xai", apiKey: acceptedKey, validateApiKey: true });
    await assert.rejects(
      adapter.configureWallet({ endpointId: "xai", apiKey: rejectedKey, validateApiKey: true }),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.message : "", "xAI API did not accept that API key. Nothing was saved.");
        return true;
      },
    );
    const models = await adapter.listModels();
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyConfigured, true);
    assert.equal(models.find((model) => model.id === "xai::grok-4.6")?.nativeMetadata.apiKeyVerified, true);
    assert.deepEqual(authorizations, [
      `Bearer ${acceptedKey}`,
      `Bearer ${rejectedKey}`,
      `Bearer ${acceptedKey}`,
    ]);
    assert.equal((await readFile(join(root, "wallet.json"), "utf8")).includes(rejectedKey), false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EYES API key validation rejects a malformed success catalogue", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-eyes-key-shape-"));
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      homeDirectory: join(root, "home"),
    });

    await assert.rejects(
      adapter.configureWallet({
        endpointId: "xai",
        apiKey: ["grok", "malformed", "catalogue", "key"].join("-"),
        validateApiKey: true,
      }),
      /returned an invalid model catalogue\. Nothing was saved\./u,
    );
    assert.equal((await adapter.getWalletStatus("xai::grok-4.6")).apiKeyConfigured, false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EYES API key validation cancels an oversized catalogue response", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-eyes-key-oversized-"));
  let bodyCancelled = false;
  try {
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          bodyCancelled = true;
        },
      }), {
        status: 200,
        headers: { "content-length": String(64 * 1024 * 1024) },
      }),
      homeDirectory: join(root, "home"),
    });

    await assert.rejects(
      adapter.configureWallet({
        endpointId: "xai",
        apiKey: ["grok", "oversized", "catalogue", "key"].join("-"),
        validateApiKey: true,
      }),
      /returned an invalid model catalogue\. Nothing was saved\./u,
    );
    assert.equal(bodyCancelled, true);
    assert.equal((await adapter.getWalletStatus("xai::grok-4.6")).apiKeyConfigured, false);
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

test("direct API 429 failures explain usage or rate limits without exposing upstream response content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-error-"));
  const upstreamSecret = ["provider", "credential", "fixture"].join("-");
  const upstreamPrompt = "confidential provider prompt fixture";
  const upstreamUrl = "https://provider.invalid/internal/retry?token=fixture";
  try {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/responses")) {
        return new Response(JSON.stringify({ error: { message: `${upstreamSecret}: ${upstreamPrompt}; ${upstreamUrl}` } }), { status: 429 });
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

    assert.equal(errorMessage, "This model has reached an API usage limit or is temporarily rate-limited. Check the provider account or try again later.");
    assert.doesNotMatch(errorMessage ?? "", new RegExp(upstreamSecret, "u"));
    assert.doesNotMatch(errorMessage ?? "", new RegExp(upstreamPrompt, "u"));
    assert.equal(errorMessage?.includes(upstreamUrl), false);
    assert.equal(errorMessage?.includes("api.openai.com"), false);
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct API auth failures are calm and other HTTP statuses retain useful status context", async (t) => {
  const cases = [
    { status: 401, expected: "The API key for this model is invalid or unavailable. Check the key and try again." },
    { status: 403, expected: "The API key for this model is invalid or unavailable. Check the key and try again." },
    { status: 503, expected: "API request failed (503)" },
  ] as const;
  for (const fixture of cases) {
    await t.test(String(fixture.status), async () => {
      const root = await mkdtemp(join(tmpdir(), `tethoq-direct-http-${fixture.status}-`));
      const upstreamSecret = `upstream-secret-${fixture.status}`;
      try {
        const fakeFetch: typeof fetch = async (input) => {
          const url = String(input);
          if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
          if (url.endsWith("/responses")) {
            return new Response(JSON.stringify({ error: { message: upstreamSecret } }), { status: fixture.status });
          }
          throw new Error(`Unexpected URL ${url}`);
        };
        const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
        await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "http", "fixture"].join("-") });
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

        await adapter.sendMessage(session.providerSessionId, { requestId: `http-${fixture.status}`, content: "Trigger a safe error" });
        await errored;

        assert.equal(errorMessage, fixture.expected);
        assert.doesNotMatch(errorMessage ?? "", new RegExp(upstreamSecret, "u"));
        await adapter.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("xAI 400 responses classify only clear credential rejection text as authentication failure", async (t) => {
  const cases = [
    {
      name: "invalid credential",
      bodyMessage: "The supplied API key credential is incorrect (sanitized-auth-body-marker).",
      marker: "sanitized-auth-body-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "authentication failed",
      bodyMessage: "Authentication failed (sanitized-auth-failed-marker).",
      marker: "sanitized-auth-failed-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "revoked API key",
      bodyMessage: "The API key was revoked (sanitized-auth-revoked-marker).",
      marker: "sanitized-auth-revoked-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "API key has expired",
      bodyMessage: "The API key has expired (sanitized-auth-expired-marker).",
      marker: "sanitized-auth-expired-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "credentials have expired",
      bodyMessage: "Credentials have expired (sanitized-credentials-expired-marker).",
      marker: "sanitized-credentials-expired-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "authentication has failed",
      bodyMessage: "Authentication has failed (sanitized-auth-has-failed-marker).",
      marker: "sanitized-auth-has-failed-marker",
      expected: "The API key for this model is invalid or unavailable. Check the key and try again.",
    },
    {
      name: "separate authentication success and malformed payload",
      bodyMessage: "Authentication succeeded, but the request payload is malformed (sanitized-mixed-body-marker).",
      marker: "sanitized-mixed-body-marker",
      expected: "API request failed (400)",
    },
    {
      name: "malformed request",
      bodyMessage: "The request payload is malformed (sanitized-request-body-marker).",
      marker: "sanitized-request-body-marker",
      expected: "API request failed (400)",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "tethoq-direct-xai-400-"));
      try {
        const fakeFetch: typeof fetch = async (input) => {
          const url = String(input);
          if (url.endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }), { status: 200 });
          }
          if (url.endsWith("/chat/completions")) {
            return new Response(JSON.stringify({ error: { message: fixture.bodyMessage } }), { status: 400 });
          }
          throw new Error(`Unexpected URL ${url}`);
        };
        const adapter = new DirectApiProviderAdapter({
          hostId: "host-test",
          statePath: join(root, "wallet.json"),
          encryptionSecret: "test-secret",
          environment: {},
          fetch: fakeFetch,
          homeDirectory: join(root, "home"),
        });
        await adapter.configureWallet({ endpointId: "xai", apiKey: ["grok", "test", "http", "fixture"].join("-") });
        const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "xai::grok-4.6" });
        let errorMessage: string | undefined;
        let resolveError!: () => void;
        const errored = new Promise<void>((resolve) => { resolveError = resolve; });
        await adapter.subscribe(session.providerSessionId, (event) => {
          if (event.type !== "agent.error") return;
          errorMessage = typeof event.payload.message === "string" ? event.payload.message : undefined;
          resolveError();
        });

        await adapter.sendMessage(session.providerSessionId, { requestId: `xai-400-${fixture.name}`, content: "Inspect" });
        await errored;

        assert.equal(errorMessage, fixture.expected);
        assert.equal(errorMessage?.includes(fixture.marker), false);
        await adapter.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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
    assert.equal(wallet.detail, "CrofAI API key is configured; provider balance was reported");
    assert.doesNotMatch(wallet.detail, /API API|being used|\bcap\b/iu);
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
    const executions: Array<{ readonly tool: string; readonly input: Record<string, unknown>; readonly context: unknown }> = [];
    adapter.configureClientTooling({
      definitions: [{ name: "browser_capture", description: "Capture the browser", inputSchema: { type: "object" } }],
      execute: async (_providerId, _providerSessionId, tool, input, context) => {
        executions.push({ tool, input, context });
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
    assert.deepEqual(executions, [{
      tool: "browser_capture",
      input: { question: "What is visible?" },
      context: { callId: "call-browser", lifecycleOwner: "provider" },
    }]);
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

test("direct parent models receive a safe EYES failure and can finish the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-eyes-failure-"));
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
        output: [{ type: "function_call", call_id: "call-eyes", name: "tethoq_turn_support", arguments: "{\"request\":\"What is visible?\"}" }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      } : {
        output_text: "EYES is temporarily unavailable because its usage limit was reached. Choose another EYES model.",
        output: [],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      }), { status: 200 });
    };
    const adapter = new DirectApiProviderAdapter({ hostId: "host-test", statePath: join(root, "wallet.json"), encryptionSecret: "test-secret", environment: {}, fetch: fakeFetch, homeDirectory: join(root, "home") });
    let executionContext: unknown;
    adapter.configureClientTooling({
      definitions: [{ name: "tethoq_turn_support", description: "Tethoq turn support", inputSchema: { type: "object" } }],
      execute: async (_providerId, _providerSessionId, _tool, _input, context) => {
        executionContext = context;
        throw new Error("429 quota exhausted for api_key=req_private C:\\private\\session https://provider.invalid/private");
      },
      mcpServer: () => ({ name: "unused", command: "node", args: [], env: {} }),
    });
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "eyes-key"].join("-"), setBalance: 1 });
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "openai::gpt-5.6-terra" });
    const events: ProviderEvent[] = [];
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => {
      events.push(event);
      if (event.type === "agent.completed") resolveCompleted();
    });
    await adapter.sendMessage(session.providerSessionId, { requestId: "eyes-error-request", content: "Inspect the image" });
    await completed;

    assert.equal(requestBodies.length, 2, "the safe tool error must be returned to the parent model for a follow-up answer");
    assert.deepEqual(executionContext, { callId: "call-eyes", lifecycleOwner: "provider" });
    assert.match(JSON.stringify(requestBodies[1]), /usage limit was reached or it is temporarily rate-limited/u);
    assert.doesNotMatch(JSON.stringify(requestBodies[1]), /req_private|provider\.invalid|private\\\\session/u);
    const failedTool = events.find((event) => event.type === "tool.completed" && event.payload.status === "failed");
    assert.match(String(failedTool?.payload.error), /usage limit was reached or it is temporarily rate-limited/u);
    assert.doesNotMatch(JSON.stringify(failedTool), /req_private|provider\.invalid|private\\\\session/u);
    assert.equal(events.some((event) => event.type === "agent.error"), false);
    assert.equal((await adapter.getSession(session.providerSessionId)).state, "completed");
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
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "audio", "key"].join("-") });
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
    await adapter.configureWallet({ endpointId: "google", apiKey: ["gemini", "test", "audio", "key"].join("-") });
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
    await adapter.configureWallet({ endpointId: "openai", apiKey: ["sk-test", "audio", "key"].join("-") });
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

test("direct OpenCode Go endpoints send the required session routing headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-opencode-session-"));
  try {
    const seen: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Go answer" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: fakeFetch,
      homeDirectory: join(root, "home"),
    });
    await adapter.configureWallet({
      endpointId: "go-proxy",
      apiKey: "test-go-key",
      customEndpoint: { id: "go-proxy", name: "Go proxy", baseUrl: "https://opencode.ai/zen/go/v1", protocol: "chat_completions", modelIds: ["mimo-v2.5"] },
    });
    await adapter.configureWallet({ endpointId: "xai", apiKey: "test-xai-key" });
    const goSession = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "go-proxy::mimo-v2.5" });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    await adapter.subscribe(goSession.providerSessionId, (event) => { if (event.type === "agent.completed") resolveDone(); });
    await adapter.sendMessage(goSession.providerSessionId, { requestId: "go-request", content: "Hello go" });
    await done;
    const inference = seen.find((entry) => entry.url === "https://opencode.ai/zen/go/v1/chat/completions");
    assert.ok(inference, "expected an inference call to the OpenCode Go endpoint");
    assert.equal(inference.headers.get("x-opencode-session"), goSession.providerSessionId);
    assert.equal(inference.headers.get("x-opencode-client"), "tethoq");
    assert.ok((inference.headers.get("user-agent") ?? "").toLowerCase().includes("tethoq"));

    const plainSession = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "xai::grok-4.6" });
    let resolvePlain!: () => void;
    const plainDone = new Promise<void>((resolve) => { resolvePlain = resolve; });
    await adapter.subscribe(plainSession.providerSessionId, (event) => { if (event.type === "agent.completed") resolvePlain(); });
    await adapter.sendMessage(plainSession.providerSessionId, { requestId: "plain-request", content: "Hello" });
    await plainDone;
    const plain = seen.find((entry) => entry.url === "https://api.x.ai/v1/chat/completions");
    assert.ok(plain);
    assert.equal(plain.headers.get("x-opencode-session"), null, "non-OpenCode endpoints must not receive the session routing header");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovered opencode-go provider sends session routing headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-direct-opencode-discovered-"));
  try {
    const seen: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const home = join(root, "home");
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await mkdir(join(home, ".cache", "opencode"), { recursive: true });
    await writeFile(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "go-discovered-key" },
    }), "utf8");
    await writeFile(join(home, ".cache", "opencode", "models.json"), JSON.stringify({
      "opencode-go": {
        id: "opencode-go",
        name: "OpenCode Go",
        api: "https://opencode.ai/zen/go/v1",
        models: { "mimo-v2.5": { id: "mimo-v2.5", name: "MiMo V2.5" } },
      },
    }), "utf8");
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Discovered answer" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = new DirectApiProviderAdapter({
      hostId: "host-test",
      statePath: join(root, "wallet.json"),
      encryptionSecret: "test-secret",
      environment: {},
      fetch: fakeFetch,
      homeDirectory: home,
    });
    const models = await adapter.listModels();
    assert.ok(models.some((model) => model.id === "opencode-go::mimo-v2.5"));
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace", modelId: "opencode-go::mimo-v2.5" });
    let resolveDiscovered!: () => void;
    const done = new Promise<void>((resolve) => { resolveDiscovered = resolve; });
    await adapter.subscribe(session.providerSessionId, (event) => { if (event.type === "agent.completed") resolveDiscovered(); });
    await adapter.sendMessage(session.providerSessionId, { requestId: "discovered-go", content: "Hi" });
    await done;
    const inference = seen.find((entry) => entry.url.endsWith("/chat/completions"));
    assert.ok(inference);
    assert.equal(inference.headers.get("x-opencode-session"), session.providerSessionId);
    assert.equal(inference.headers.get("x-opencode-client"), "tethoq");
    await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
