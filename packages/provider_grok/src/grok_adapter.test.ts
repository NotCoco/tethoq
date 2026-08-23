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
  reportedModelSelection,
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

test("Grok 4.6 catalogue exposes documented reasoning efforts", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: {},
    _meta: {
      model_state: {
        currentModelId: "grok-4.6",
        availableModels: [
          { id: "grok-4.6", name: "Grok 4.6" },
          { id: "grok-code", name: "Grok Code" },
        ],
      },
    },
  });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const models = await adapter.listModels();
  const grok46 = models.find((model) => model.id === "grok-4.6");
  const grokCode = models.find((model) => model.id === "grok-code");
  assert.deepEqual(grok46?.nativeMetadata.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(grok46?.nativeMetadata.defaultReasoningEffort, "high");
  assert.equal(grokCode?.nativeMetadata.supportedReasoningEfforts, undefined);
  await adapter.dispose();
});

test("Grok thinking content on an agent message is live reasoning", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "session-think",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "thinking", thinking: "Tracing the failure" } },
    },
  });
  await delay();
  const thought = events.find((event) => event.type === "message.delta");
  assert.equal(thought?.payload.partType, "reasoning");
  await adapter.dispose();
});

test("Grok marks a session working when a prompt starts", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "session-prompt" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("session-prompt", { requestId: "request-1", content: "Inspect" });
  const working = events.find((event) => event.type === "session.status_changed");
  assert.equal(working?.payload.state, "working");
  assert.equal(adapter.hasActiveTurn("session-prompt"), true);
  await adapter.dispose();
});

test("Grok native queue/changed entries are listed and published to the bridge", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({
    method: "_x.ai/queue/changed",
    params: {
      sessionId: "grok-session",
      entries: [{ id: "native-q1", kind: "prompt", text: "Queued from the CLI" }],
    },
  });
  await delay();
  const listed = await adapter.listQueuedMessages?.();
  assert.deepEqual(listed?.map((message) => [message.id, message.content, message.providerSessionId]), [
    ["native-q1", "Queued from the CLI", "grok-session"],
  ]);
  const published = events.find((event) => event.type === "message.queue_updated");
  assert.equal(Array.isArray(published?.payload.messages), true);
  assert.equal((published?.payload.messages as { id: string }[])[0]?.id, "native-q1");
  await adapter.dispose();
});

test("Grok enqueue uses session/prompt so the CLI owns the follow-up", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-session" });
  transport.notificationsBeforeResult.set("session/prompt", [{
    method: "_x.ai/queue/changed",
    params: {
      sessionId: "grok-session",
      entries: [{ id: "native-q2", kind: "prompt", text: "Ask this next" }],
    },
  }]);
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const queued = await adapter.enqueueQueuedMessage?.("grok-session", {
    requestId: "request-queue",
    content: "Ask this next",
    workingDirectory: "C:\\workspace",
  });
  assert.equal(queued?.id, "native-q2");
  assert.equal(queued?.content, "Ask this next");
  const prompt = transport.sent.find((message) => typeof message === "object"
    && message !== null
    && (message as Record<string, unknown>).method === "session/prompt") as Record<string, unknown>;
  assert.deepEqual((prompt.params as Record<string, unknown>).prompt, [{ type: "text", text: "Ask this next" }]);
  await adapter.dispose();
});

test("Grok queue edit and remove use native ACP notifications", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  await adapter.subscribe(null, () => undefined);
  transport.push({
    method: "_x.ai/queue/changed",
    params: {
      sessionId: "grok-session",
      entries: [{ id: "native-q3", kind: "prompt", text: "Original" }],
    },
  });
  await delay();
  const updated = await adapter.updateQueuedMessage?.("grok-session", "native-q3", "Revised");
  assert.equal(updated?.content, "Revised");
  const removed = await adapter.cancelQueuedMessage?.("grok-session", "native-q3");
  assert.equal(removed, true);
  const methods = transport.sent.flatMap((message) => (
    typeof message === "object" && message !== null && typeof (message as Record<string, unknown>).method === "string"
      ? [(message as Record<string, unknown>).method as string]
      : []
  ));
  assert.ok(methods.includes("_x.ai/queue/edit"));
  assert.ok(methods.includes("_x.ai/queue/remove"));
  await adapter.dispose();
});

test("public ACP adapters do not claim Grok's native queue", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });
  assert.equal(adapter.enqueueQueuedMessage, undefined);
  assert.equal(adapter.listQueuedMessages, undefined);
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

  transport.push({
    method: "session/update",
    params: {
      sessionId: "usage-session",
      update: {
        sessionUpdate: "session_info_update",
        sessionUsage: { input_tokens: 180_000, output_tokens: 20_000, total_tokens: 400_000 },
        context_usage: { used_tokens: 203_000, context_window_tokens: 500_000, used_percent: 40.6 },
      },
    },
  });
  await delay();
  const occupancy = await adapter.getSessionContext("usage-session");
  assert.equal(occupancy.usedTokens, 203_000);
  assert.equal(occupancy.contextWindowTokens, 500_000);
  assert.equal(occupancy.usage.totalTokens, 400_000);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "usage-session",
      update: {
        sessionUpdate: "session_info_update",
        tokens: 400_000,
        sessionUsage: { total_tokens: 400_000 },
      },
    },
  });
  await delay();
  const billedIsNotOccupancy = await adapter.getSessionContext("usage-session");
  assert.equal(billedIsNotOccupancy.usedTokens, 203_000);
  await adapter.dispose();
});

test("ACP context falls back to the reported total when no occupancy is given", async () => {
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
  transport.methodResults.set("session/new", { sessionId: "usage-only-session" });
  // A prompt result with usage but no context_usage: the provider gives the
  // billed request totals only, so the panel must reconcile "Used" with them
  // instead of showing Unavailable next to real Input / Output figures.
  transport.methodResults.set("session/prompt", {
    stopReason: "end_turn",
    modelId: "coder",
    sessionUsage: { input_tokens: 14_684, output_tokens: 44, total_tokens: 14_728 },
  });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });

  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("usage-only-session", { requestId: "request-usage", content: "Hi" });
  await delay();
  const context = await adapter.getSessionContext("usage-only-session");
  assert.equal(context.usedTokens, 14_728, "used falls back to the reported total");
  assert.equal(context.contextWindowTokens, 200_000);
  assert.equal(context.usedPercent, 7.364);
  assert.deepEqual(context.usage, {
    inputTokens: 14_684,
    outputTokens: 44,
    totalTokens: 14_728,
  });
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

test("Grok keeps live thought deltas flowing instead of session/load during a turn", async () => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("session/prompt");
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
  });
  transport.methodResults.set("session/new", { sessionId: "live-session" });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("live-session", { requestId: "r1", content: "Think" });
  assert.equal(adapter.hasActiveTurn("live-session"), true);
  const loadCount = () => transport.sent.filter((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/load").length;
  const loadsBeforeThought = loadCount();
  await adapter.getMessages("live-session");
  assert.equal(loadCount(), loadsBeforeThought, "a live turn with no chunk yet must not session/load");

  transport.push({
    method: "session/update",
    params: {
      sessionId: "live-session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Step one" } },
    },
  });
  await delay();
  assert.equal(events.filter((event) => event.type === "message.delta").at(-1)?.payload.text, "Step one");

  const before = loadCount();
  const liveHistory = await adapter.getMessages("live-session");
  assert.equal(loadCount(), before, "an attached live turn must not session/load the transcript");
  assert.equal(liveHistory.at(-1)?.parts.some((part) => part.type === "reasoning" && part.text === "Step one"), true);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "live-session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Step two" } },
    },
  });
  await delay();
  assert.equal(events.filter((event) => event.type === "message.delta").at(-1)?.payload.text, "Step two");
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
  assert.equal(adapter.hasActiveTurn("parent-1"), true);
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

test("Grok watch keeps the ACP peer and never replays history for an attached session", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true, list: true } },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "watched-session", cwd: "C:\\workspace" }],
    nextCursor: null,
  });
  transport.methodResults.set("session/load", {});
  transport.methodResults.set("session/resume", {});
  const adapter = new GrokProviderAdapter({ hostId: "host_1", idleReleaseMs: 5, transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.getMessages("watched-session");
  const loadCount = () => transport.sent.filter((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/load").length;
  const loadsAfterOpen = loadCount();
  assert.ok(loadsAfterOpen >= 1);

  await adapter.watchSession("watched-session");
  await adapter.releaseIdleResources();
  await delay(20);
  assert.equal(transport.closeCalls, 0, "a watched session must keep the live ACP connection");

  await adapter.getMessages("watched-session");
  assert.ok(loadCount() >= loadsAfterOpen, "a quiet attached session may catch up with session/load");

  transport.push({
    method: "session/update",
    params: {
      sessionId: "watched-session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Only the new part" } },
    },
  });
  await delay();
  assert.equal(events.filter((event) => event.type === "message.delta").at(-1)?.payload.text, "Only the new part");
  await adapter.dispose();
});

test("Grok session/load publishes the session's real reasoning effort", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: true } },
  });
  transport.methodResults.set("session/load", {
    configOptions: [
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "xhigh",
        options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
    ],
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "effort-session", cwd: "C:\\workspace", title: "Effort chat" }],
    nextCursor: null,
  });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });

  const messages = await adapter.getMessages("effort-session");
  assert.equal(messages.length, 0);
  await delay();
  const published = events.find((event) => event.type === "session.updated");
  assert.equal(published?.payload.reasoningEffort, "xhigh", "reopening must publish the learned session effort");
  assert.equal(published?.providerSessionId, "effort-session");

  const session = await adapter.getSession("effort-session");
  assert.equal(session.reasoningEffort, "xhigh", "the listed session carries the real effort");
  await adapter.dispose();
});

test("a turn that streamed a moment ago still reports completion", async () => {
  const events: ProviderEvent[] = [];
  const adapter = createPublicAcpProviderAdapter("qwen", {
    hostId: "host_terminal",
    transportFactory: () => {
      const transport = new FakeTransport();
      transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
      transport.methodResults.set("session/new", { sessionId: "live-session" });
      transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
      // A chunk lands immediately before the prompt resolves. Chunk recency used
      // to suppress the terminal event, leaving the task working and its rows
      // shimmering with no way back except clicking away.
      transport.notificationsBeforeResult.set("session/prompt", [{
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "live-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } } },
      }]);
      return transport;
    },
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\workspace" });

  await adapter.sendMessage("live-session", { requestId: "one", content: "Say PONG" });
  await delay(40);

  assert.ok(events.some((event) => event.type === "message.delta" && event.providerSessionId === "live-session"));
  assert.ok(events.some((event) => event.type === "agent.completed" && event.providerSessionId === "live-session"));
  // The live-turn marker is cleared, so a later history catch-up is allowed again.
  assert.equal(adapter.hasActiveTurn("live-session"), false);
  await adapter.dispose();
});

test("the reasoning level a session is really running is read from the harness", async () => {
  const events: ProviderEvent[] = [];
  let transport: FakeTransport | undefined;
  const adapter = createPublicAcpProviderAdapter("qwen", {
    hostId: "host_effort",
    transportFactory: () => {
      const created = new FakeTransport();
      created.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
      created.methodResults.set("session/new", { sessionId: "effort-session" });
      transport = created;
      return created;
    },
  });
  await adapter.subscribe(null, (event) => { if (event.type === "session.updated") events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\workspace" });

  // The session listing the harness pushes on connect carries the real level, so
  // reopening a chat shows what it is running rather than the model default.
  transport?.push({
    jsonrpc: "2.0",
    method: "_x.ai/sessions/changed",
    params: { upserted: [{ sessionId: "effort-session", modelId: "grok-4.6", reasoningEffort: "xhigh" }], removed: [] },
  });
  await delay(20);
  assert.equal(events.at(-1)?.payload.reasoningEffort, "xhigh");
  assert.equal(events.at(-1)?.providerSessionId, "effort-session");

  // A level changed inside the harness itself is announced too, and must land.
  transport?.push({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: { sessionId: "effort-session", update: { sessionUpdate: "model_changed", model_id: "grok-4.6", reasoning_effort: "low" } },
  });
  await delay(20);
  assert.equal(events.at(-1)?.payload.reasoningEffort, "low");

  // Repeating what clients already know must not churn the UI.
  const settled = events.length;
  transport?.push({
    jsonrpc: "2.0",
    method: "_x.ai/sessions/changed",
    params: { upserted: [{ sessionId: "effort-session", modelId: "grok-4.6", reasoningEffort: "low" }], removed: [] },
  });
  await delay(20);
  assert.equal(events.length, settled);
  await adapter.dispose();
});

test("reopening a chat learns its reasoning level from the session it loads", async () => {
  // Grok's session listing carries no reasoning level, so a cold start can only
  // learn it from the model block returned when the chat is opened.
  const loadResult = {
    models: {
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEffort: "high" } },
        { modelId: "grok-4.6", name: "Grok 4.6", _meta: { supportsReasoningEffort: true, reasoningEffort: "xhigh" } },
      ],
    },
  };
  assert.deepEqual(reportedModelSelection(loadResult), { modelId: "grok-4.6", reasoningEffort: "xhigh" });
  assert.equal(reportedModelSelection({ models: { currentModelId: "grok-4.6" } }), undefined);
  assert.equal(reportedModelSelection({ sessions: [] }), undefined);

  const events: ProviderEvent[] = [];
  const adapter = createPublicAcpProviderAdapter("qwen", {
    hostId: "host_reopen",
    transportFactory: () => {
      const transport = new FakeTransport();
      transport.methodResults.set("initialize", {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
      });
      transport.methodResults.set("session/new", { sessionId: "reopened" });
      transport.methodResults.set("session/load", loadResult);
      return transport;
    },
  });
  await adapter.subscribe(null, (event) => { if (event.type === "session.updated") events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\workspace" });

  await adapter.getMessages("reopened");
  await delay(20);

  const learned = events.filter((event) => event.payload.reasoningEffort !== undefined);
  assert.equal(learned.at(-1)?.payload.reasoningEffort, "xhigh");
  assert.equal(learned.at(-1)?.providerSessionId, "reopened");
  await adapter.dispose();
});
