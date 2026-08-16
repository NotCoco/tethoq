import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { JsonRpcTransport, ProviderEvent } from "../../provider_contract/src/index.js";
import {
  createPublicAcpProviderAdapter,
  GrokProviderAdapter,
  PUBLIC_ACP_PROVIDER_PRESETS,
} from "./grok_adapter.js";

class FakeTransport implements JsonRpcTransport {
  readonly listeners = new Set<(message: unknown) => void>();
  readonly methodResults = new Map<string, unknown>();
  readonly notificationsBeforeResult = new Map<string, readonly unknown[]>();
  readonly blockedMethods = new Set<string>();
  readonly sent: unknown[] = [];
  public closeCalls = 0;

  public async send(message: unknown): Promise<void> {
    this.sent.push(message);
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if ((typeof record.id !== "string" && typeof record.id !== "number") || typeof record.method !== "string") return;
    if (this.blockedMethods.has(record.method)) return;
    const result = this.methodResults.get(record.method) ?? {};
    for (const notification of this.notificationsBeforeResult.get(record.method) ?? []) this.push(notification);
    setTimeout(() => this.push({ id: record.id, result }), 1);
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> { this.closeCalls += 1; }

  public push(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }
}

test("ACP releases an idle process, resumes cached sessions, and keeps event subscriptions", async () => {
  const transports: FakeTransport[] = [];
  const events: ProviderEvent[] = [];
  const adapter = createPublicAcpProviderAdapter("qwen", {
    hostId: "host_idle",
    idleReleaseMs: 5,
    transportFactory: () => {
      const transport = new FakeTransport();
      transport.methodResults.set("initialize", {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: true }, loadSession: true },
      });
      transport.methodResults.set("session/new", { sessionId: "cached-session" });
      transport.methodResults.set("session/resume", {});
      transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
      transports.push(transport);
      return transport;
    },
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal(transports[0]?.closeCalls, 1);

  await adapter.sendMessage("cached-session", { requestId: "after-idle", content: "Continue" });
  await delay(15);
  const reopenedMethods = transports[1]?.sent.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const method = (message as Record<string, unknown>).method;
    return typeof method === "string" ? [method] : [];
  }) ?? [];
  assert.ok(reopenedMethods.includes("session/resume"));
  assert.ok(reopenedMethods.includes("session/prompt"));
  assert.ok(events.some((event) => event.type === "agent.completed" && event.providerSessionId === "cached-session"));
  await adapter.dispose();
});

test("ACP dispose closes a peer whose initialize request is still pending", async () => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("initialize");
  const adapter = createPublicAcpProviderAdapter("qwen", {
    hostId: "host_dispose_initializing",
    requestTimeoutMs: 1_000,
    transportFactory: () => transport,
  });
  const initialization = adapter.getAuthStatus().then(
    () => undefined,
    (error: unknown) => error,
  );
  while (!transport.sent.some((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "initialize")) {
    await delay(1);
  }

  await adapter.dispose();

  assert.equal(transport.closeCalls, 1);
  assert.ok(await initialization instanceof Error);
});

test("public ACP detection resolves Windows command shims through PATH and PATHEXT", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-acp-detect-"));
  const command = `tethoq-acp-shim-${process.pid}`;
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  try {
    await writeFile(join(directory, `${command}.cmd`), "@echo off\r\necho public-acp-shim 9.7.1\r\n", "utf8");
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD";

    const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", command });
    const detection = await adapter.detect();

    assert.equal(detection.available, true);
    assert.equal(detection.version, "public-acp-shim 9.7.1");
    assert.equal(detection.executable, command);
    await adapter.dispose();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    await rm(directory, { recursive: true, force: true });
  }
});

test("public ACP presets keep their documented launch commands and configured identity", async () => {
  assert.deepEqual(Object.values(PUBLIC_ACP_PROVIDER_PRESETS).map((preset) => ({
    providerId: preset.providerId,
    command: preset.command,
    args: preset.commandArgs,
  })), [
    { providerId: "qwen", command: "qwen", args: ["--acp"] },
    { providerId: "goose", command: "goose", args: ["acp"] },
    { providerId: "kimi", command: "kimi", args: ["acp"] },
    { providerId: "hermes", command: "hermes", args: ["acp"] },
    { providerId: "cline", command: "cline", args: ["--acp"] },
    { providerId: "copilot", command: "copilot", args: ["--acp", "--stdio"] },
  ]);

  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
    _meta: { model_state: { currentModelId: "coder", availableModels: ["coder"] } },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "session-1", cwd: "C:\\workspace" }],
    nextCursor: null,
  });
  transport.notificationsBeforeResult.set("session/load", [{
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Done" } },
    },
  }]);
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });
  const [model] = await adapter.listModels();
  const [session] = (await adapter.listSessions()).sessions;
  const [message] = await adapter.getMessages("session-1");
  assert.equal(adapter.providerId, "qwen");
  assert.equal(adapter.displayName, "Qwen Code");
  assert.equal(model?.providerId, "qwen");
  assert.equal(session?.providerId, "qwen");
  assert.equal(session?.id, "host_1/qwen/session-1");
  assert.equal(session?.title, "Untitled Qwen Code session");
  assert.equal(message?.id, "qwen/message-1");
  assert.equal(message?.sessionId, "host_1/qwen/session-1");
  await adapter.dispose();
});

test("ACP model enumeration preserves advertised input modalities and context limits", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } },
    _meta: {
      model_state: {
        currentModelId: "vision-coder",
        availableModels: [
          {
            id: "vision-coder",
            name: "Vision Coder",
            inputModalities: ["text", "image/png"],
            contextWindowTokens: 128_000,
          },
          {
            id: "text-coder",
            capabilities: { input_modalities: ["text"] },
            limits: { context: 64_000 },
          },
          "agent-defaults",
        ],
      },
    },
  });
  const adapter = createPublicAcpProviderAdapter("cline", { hostId: "host_1", transportFactory: () => transport });

  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => ({ id: model.id, modalities: model.inputModalities })), [
    { id: "vision-coder", modalities: ["text", "image"] },
    { id: "text-coder", modalities: ["text"] },
    { id: "agent-defaults", modalities: ["text", "image"] },
  ]);
  const context = await adapter.getSessionContext("session-with-no-usage");
  assert.equal(context.modelId, "vision-coder");
  assert.equal(context.contextWindowTokens, 128_000);
  assert.equal(context.usedTokens, null);
  assert.equal(context.usedPercent, null);
  assert.deepEqual(context.usage, {});
  assert.equal(context.supportsManualCompaction, false);
  assert.equal("compactSession" in adapter, false);
  await adapter.dispose();
});

test("ACP prompts encode image attachments as standard image content blocks", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "image-session" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = createPublicAcpProviderAdapter("copilot", { hostId: "host_1", transportFactory: () => transport });
  let boundSessionId: string | undefined;
  adapter.configureClientTooling({
    definitions: [{ name: "browser_inspect", description: "Inspect the browser", inputSchema: { type: "object" } }],
    async execute() { return {}; },
    mcpServer() { return { name: "mesh", command: "node", args: ["mesh.js"], env: { BOUND: "1" } }; },
    createSessionBinding() {
      return {
        server: { name: "mesh", command: "node", args: ["mesh.js"], env: { BINDING: "pending" } },
        bind(providerSessionId) { boundSessionId = providerSessionId; },
        release() {},
      };
    },
  });

  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("image-session", {
    requestId: "request-image",
    content: "What is in this screenshot?",
    attachments: [{
      name: "screen.png",
      mimeType: "image/png",
      dataBase64: "aW1hZ2U=",
      byteLength: 5,
    }],
  });
  await delay();

  const promptRequest = transport.sent.find((message) => typeof message === "object"
    && message !== null
    && (message as Record<string, unknown>).method === "session/prompt") as Record<string, unknown>;
  assert.deepEqual((promptRequest.params as Record<string, unknown>).prompt, [
    { type: "text", text: "What is in this screenshot?" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  const newSessionRequest = transport.sent.find((message) => typeof message === "object"
    && message !== null
    && (message as Record<string, unknown>).method === "session/new") as Record<string, unknown>;
  assert.deepEqual((newSessionRequest.params as Record<string, unknown>).mcpServers, [{
    name: "mesh",
    command: "node",
    args: ["mesh.js"],
    env: [{ name: "BINDING", value: "pending" }],
  }]);
  assert.equal(boundSessionId, "image-session");
  assert.equal(transport.sent.some((message) => typeof message === "object"
    && message !== null
    && (message as Record<string, unknown>).method === "session/resume"), false);
  await adapter.dispose();
});

test("ACP sessions apply advertised model and reasoning config before the first prompt", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", {
    sessionId: "configured-session",
    configOptions: [
      {
        id: "models",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: [{ group: "Available", options: [{ value: "model-a" }, { value: "model-b" }] }],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [{ value: "medium" }, { value: "high" }],
      },
    ],
  });
  transport.methodResults.set("session/set_config_option", {});
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });

  await adapter.createSession({
    workingDirectory: "C:\\workspace",
    modelId: "model-b",
    reasoningEffort: "high",
    firstInstruction: "Inspect this project",
  });

  const requests = transport.sent.flatMap((message): readonly Record<string, unknown>[] => (
    typeof message === "object" && message !== null ? [message as Record<string, unknown>] : []
  ));
  assert.deepEqual(requests.filter((request) => request.method === "session/set_config_option").map((request) => request.params), [
    { sessionId: "configured-session", configId: "models", value: "model-b" },
    { sessionId: "configured-session", configId: "thinking", value: "high" },
  ]);
  assert.deepEqual(requests.filter((request) => request.method === "session/prompt").map((request) => request.params), [{
    sessionId: "configured-session",
    prompt: [{ type: "text", text: "Inspect this project" }],
  }]);
  const context = await adapter.getSessionContext("configured-session");
  assert.equal(context.modelId, "model-b");
  await adapter.dispose();
});

test("ACP session context uses only usage reported by prompt results and updates", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: {},
    _meta: {
      model_state: {
        currentModelId: "coder",
        availableModels: [{ id: "coder", context_window: 200_000 }],
      },
    },
  });
  transport.methodResults.set("session/new", { sessionId: "usage-session" });
  transport.methodResults.set("session/prompt", {
    stopReason: "end_turn",
    modelId: "coder",
    usage: {
      inputTokens: 1_200,
      outputTokens: 300,
      totalTokens: 1_500,
      cost: { amount: 0.015, currency: "USD" },
    },
    contextUsage: { usedTokens: 12_500 },
  });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });

  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const before = await adapter.getSessionContext("usage-session");
  assert.equal(before.usedTokens, null);
  assert.deepEqual(before.usage, {});

  await adapter.sendMessage("usage-session", { requestId: "request-usage", content: "Inspect" });
  await delay();
  const fromResult = await adapter.getSessionContext("usage-session");
  assert.equal(fromResult.usedTokens, 12_500);
  assert.equal(fromResult.contextWindowTokens, 200_000);
  assert.equal(fromResult.usedPercent, 6.25);
  assert.deepEqual(fromResult.usage, {
    inputTokens: 1_200,
    outputTokens: 300,
    totalTokens: 1_500,
    cost: 0.015,
    currency: "USD",
  });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "usage-session",
      update: {
        sessionUpdate: "session_info_update",
        sessionUsage: { input_tokens: 1_500, output_tokens: 400, total_tokens: 1_900, total_cost: 0.019 },
        context_usage: { used_tokens: 14_000, context_window_tokens: 200_000, used_percent: 7 },
      },
    },
  });
  await delay();
  const fromUpdate = await adapter.getSessionContext("usage-session");
  assert.equal(fromUpdate.usedTokens, 14_000);
  assert.equal(fromUpdate.usedPercent, 7);
  assert.deepEqual(fromUpdate.usage, {
    inputTokens: 1_500,
    outputTokens: 400,
    totalTokens: 1_900,
    cost: 0.019,
    currency: "USD",
  });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "usage-session",
      update: {
        sessionUpdate: "usage_update",
        used: 15_000,
        size: 200_000,
        cost: { amount: 0.021, currency: "USD" },
      },
    },
  });
  await delay();
  const fromCanonicalUsageUpdate = await adapter.getSessionContext("usage-session");
  assert.equal(fromCanonicalUsageUpdate.usedTokens, 15_000);
  assert.equal(fromCanonicalUsageUpdate.contextWindowTokens, 200_000);
  assert.equal(fromCanonicalUsageUpdate.usedPercent, 7.5);
  assert.equal(fromCanonicalUsageUpdate.usage.cost, 0.021);
  assert.equal(fromCanonicalUsageUpdate.usage.currency, "USD");
  await adapter.dispose();
});

test("ACP agents without load or resume can prompt the session they just created", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "fresh-session" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = createPublicAcpProviderAdapter("goose", { hostId: "host_1", idleReleaseMs: 5, transportFactory: () => transport });

  await adapter.createSession({ workingDirectory: "C:\\workspace", firstInstruction: "Inspect this project" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await adapter.releaseIdleResources();
  await delay(15);

  const methods = transport.sent.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const method = (message as Record<string, unknown>).method;
    return typeof method === "string" ? [method] : [];
  });
  assert.ok(methods.includes("session/prompt"));
  assert.ok(!methods.includes("session/load"));
  assert.ok(!methods.includes("session/resume"));
  assert.equal(transport.closeCalls, 0, "a non-resumable active ACP session must keep its process");
  await adapter.dispose();
});

test("ACP helper sessions keep bridge client tools disabled on their first prompt", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: true }, loadSession: true },
  });
  transport.methodResults.set("session/new", { sessionId: "helper-session" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });
  let bindingCreations = 0;
  adapter.configureClientTooling({
    definitions: [],
    async execute() { return {}; },
    mcpServer() { return { name: "mesh", command: "node", args: ["mesh.js"], env: {} }; },
    createSessionBinding() {
      bindingCreations += 1;
      return {
        server: { name: "mesh", command: "node", args: ["mesh.js"], env: {} },
        bind() {},
        release() {},
      };
    },
  });

  await adapter.createSession({
    workingDirectory: "C:\\workspace",
    clientTools: "none",
    mcpServers: "none",
    firstInstruction: "Describe the image only",
  });
  await delay();

  const requests = transport.sent.flatMap((message): readonly Record<string, unknown>[] => (
    typeof message === "object" && message !== null ? [message as Record<string, unknown>] : []
  ));
  const newSession = requests.find((request) => request.method === "session/new");
  assert.deepEqual((newSession?.params as Record<string, unknown>).mcpServers, []);
  assert.equal(bindingCreations, 0);
  assert.equal(requests.some((request) => request.method === "session/resume" || request.method === "session/load"), false);
  assert.equal(requests.filter((request) => request.method === "session/prompt").length, 1);
  await adapter.dispose();
});

test("Grok session/load coalesces 1.0.3 history chunks that omit messageId", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-history", cwd: "C:\\workspace", title: "History" }],
    nextCursor: null,
  });
  transport.notificationsBeforeResult.set("session/load", [
    {
      method: "session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Inspect the project" },
          _meta: { modelId: "grok-4.6", promptIndex: 0 },
        },
        _meta: { eventId: "grok-history-2", agentTimestampMs: 1_786_566_384_907 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Checking the repository." },
        },
        _meta: { promptId: "prompt-1", chunkId: 34, agentTimestampMs: 1_786_566_387_397 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I'll inspect " },
        },
        _meta: { promptId: "prompt-1", chunkId: 35, agentTimestampMs: 1_786_566_387_398 },
      },
    },
    {
      method: "_x.ai/session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "and report back." },
        },
        _meta: { promptId: "prompt-1", chunkId: 36, agentTimestampMs: 1_786_566_387_399 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Continue" },
          _meta: { modelId: "grok-4.6", promptIndex: 1 },
        },
        _meta: { eventId: "grok-history-40", agentTimestampMs: 1_786_566_390_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-history",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
        _meta: { promptId: "prompt-2", chunkId: 4, agentTimestampMs: 1_786_566_391_000 },
      },
    },
  ]);

  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const messages = await adapter.getMessages("grok-history");
  assert.deepEqual(messages.map((message) => message.providerMessageId), [
    "user_prompt_0",
    "assistant_prompt_prompt-1",
    "user_prompt_1",
    "assistant_prompt_prompt-2",
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.parts.map((part) => part.type === "text" ? part.text : "").join("")), [
    "Inspect the project",
    "I'll inspect and report back.",
    "Continue",
    "Done.",
  ]);
  assert.deepEqual(messages[1]?.parts, [
    { type: "reasoning", text: "Checking the repository.", redacted: false },
    { type: "text", text: "I'll inspect and report back." },
  ]);
  await adapter.dispose();
});

test("Grok passes the scoped mesh MCP server when resuming a session", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true, resume: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", { sessions: [{ sessionId: "grok-parent", cwd: "C:\\workspace" }], nextCursor: null });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  adapter.configureClientTooling({
    definitions: [],
    async execute() { return {}; },
    mcpServer: () => ({ name: "uar_mesh", command: "node", args: ["mesh.js"], env: { TOKEN: "secret" } }),
  });
  await adapter.listSessions();
  await adapter.resumeSession("grok-parent");
  const resume = transport.sent.find((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/resume") as Record<string, unknown>;
  assert.deepEqual((resume.params as Record<string, unknown>).mcpServers, [{
    name: "uar_mesh",
    command: "node",
    args: ["mesh.js"],
    env: [{ name: "TOKEN", value: "secret" }],
  }]);
  await adapter.dispose();
});

function delay(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ACP surfaces rejected JSON-RPC callbacks as a provider connection event", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.subscribe(null, async (event) => {
    if (event.type === "message.delta") throw new Error("callback failed");
  });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } },
    },
  });
  await delay();

  const disconnected = events.find((event) => event.type === "provider.disconnected");
  assert.deepEqual(disconnected?.payload, { message: "callback failed", source: "json_rpc_callback" });
  await adapter.dispose();
});

test("Grok accepts standard and xAI session updates and links only list-resolved children", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "child-openable", cwd: "C:\\workspace", title: "Child" }],
    nextCursor: null,
  });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting the parser" },
      },
    },
  });
  await delay();
  const thought = events.at(-1);
  assert.equal(thought?.type, "message.delta");
  assert.equal(thought?.payload.partType, "reasoning");
  assert.deepEqual(thought?.payload.content, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Inspecting the parser" },
  });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "worker-1",
        child_session_id: "child-openable",
        description: "Inspect the parser",
      },
    },
  });
  await delay();

  transport.push({
    method: "_x.ai/session/update",
    params: {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: "worker-1",
        child_session_id: "child-openable",
        status: "completed",
        output: "Parser inspected",
      },
    },
  });
  await delay();

  const lifecycle = events.filter((event) => event.type === "tool.started" || event.type === "tool.completed");
  assert.deepEqual(lifecycle.map((event) => event.type), ["tool.started", "tool.completed"]);
  const parts = lifecycle.map((event) => Array.isArray(event.payload.parts) ? event.payload.parts[0] : undefined);
  assert.deepEqual(parts.map((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return undefined;
    return part.receiverSessionIds;
  }), [["host_1/grok/child-openable"], ["host_1/grok/child-openable"]]);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "worker-2",
        child_session_id: "child-not-listed",
        description: "Unresolved child",
      },
    },
  });
  await delay();
  const unresolved = events.at(-1)?.payload.parts;
  assert.ok(Array.isArray(unresolved));
  const unresolvedPart = unresolved[0];
  assert.ok(typeof unresolvedPart === "object" && unresolvedPart !== null && !Array.isArray(unresolvedPart));
  assert.deepEqual(unresolvedPart.receiverSessionIds, []);

  await adapter.dispose();
});
