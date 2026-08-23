import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, mergeCodexMessageHistory } from "./codex_adapter.js";
import type { JsonRpcTransport, ProviderClientTooling, ProviderEvent } from "../../provider_contract/src/index.js";

class FakeTransport implements JsonRpcTransport {
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();
  readonly methodResults = new Map<string, unknown>();
  readonly methodResponses = new Map<string, Array<{ readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }>>();
  readonly blockedMethods = new Set<string>();
  public closeCalls = 0;
  public async send(message: unknown): Promise<void> {
    this.sent.push(message);
    // Auto-respond to client requests so peer initialization completes.
    if (typeof message === "object" && message !== null) {
      const record = message as Record<string, unknown>;
      if (typeof record.id === "string" || typeof record.id === "number") {
        if (typeof record.method === "string" && !("result" in record) && !("error" in record)) {
          if (this.blockedMethods.has(record.method)) return;
          const id = record.id;
          const queued = this.methodResponses.get(record.method)?.shift();
          if (queued?.error !== undefined) {
            setTimeout(() => this.push({ id, error: queued.error }), 1);
            return;
          }
          const result = queued !== undefined && "result" in queued ? queued.result : this.methodResults.has(record.method)
            ? this.methodResults.get(record.method)
            : record.method === "account/read" ? { account: null, requiresOpenaiAuth: false } : {};
          setTimeout(() => this.push({ id, result }), 1);
        }
      }
    }
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

function sentResult(transport: FakeTransport, id: string): unknown {
  const response = transport.sent.find((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    return record.id === id && "result" in record;
  });
  return response === undefined ? undefined : (response as Record<string, unknown>).result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adapterWithPeer(): Promise<{ adapter: CodexAdapter; transport: FakeTransport; events: ProviderEvent[] }> {
  const transport = new FakeTransport();
  const events: ProviderEvent[] = [];
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport });
  await adapter.subscribe(null, (event) => { events.push(event); });
  // force peer initialization through a benign request
  await adapter.getAuthStatus();
  return { adapter, transport, events };
}

test("Codex advertises the native desktop queue only when synchronization is configured", () => {
  const standard = new CodexAdapter({ hostId: "host_queue_default", transportFactory: () => new FakeTransport() });
  const synchronized = new CodexAdapter({
    hostId: "host_queue_enabled",
    transportFactory: () => new FakeTransport(),
    desktopQueue: { statePath: "C:\\queue-test\\state.json", pipePath: "\\\\.\\pipe\\queue-test" },
  });
  assert.equal(standard.listQueuedMessages, undefined);
  assert.equal(standard.enqueueQueuedMessage, undefined);
  assert.equal(standard.restoreQueuedMessage, undefined);
  assert.equal(standard.updateQueuedMessage, undefined);
  assert.equal(standard.cancelQueuedMessage, undefined);
  assert.equal(typeof synchronized.listQueuedMessages, "function");
  assert.equal(typeof synchronized.enqueueQueuedMessage, "function");
  assert.equal(typeof synchronized.restoreQueuedMessage, "function");
  assert.equal(typeof synchronized.updateQueuedMessage, "function");
  assert.equal(typeof synchronized.cancelQueuedMessage, "function");
  standard.dispose();
  synchronized.dispose();
});

test("Codex releases an idle app-server after a grace period and reopens it on demand", async () => {
  const transports: FakeTransport[] = [];
  const adapter = new CodexAdapter({
    hostId: "host_idle",
    idleReleaseMs: 5,
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
  });

  await adapter.getAuthStatus();
  await adapter.releaseIdleResources();
  await adapter.getAuthStatus();
  await delay(15);
  assert.equal(transports[0]?.closeCalls, 0, "peer use cancels the pending idle close");

  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal(transports[0]?.closeCalls, 1);
  await adapter.getAuthStatus();
  assert.equal(transports.length, 2);
  await adapter.dispose();
});

test("Codex dispose closes a peer whose initialize request is still pending", async () => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("initialize");
  const adapter = new CodexAdapter({
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

test("Codex forwards audio recordings separately from images", async () => {
  const { adapter, transport } = await adapterWithPeer();

  await adapter.sendMessage("thread-audio", {
    requestId: "audio-turn-1",
    content: "Listen to this",
    attachments: [{ name: "dictation.mp3", mimeType: "audio/mpeg", dataBase64: "aGVsbG8=", byteLength: 5 }],
  });

  const request = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "turn/start"
  ) as Record<string, unknown> | undefined;
  assert.ok(request);
  assert.deepEqual((request.params as { input: unknown }).input, [
    { type: "text", text: "Listen to this", text_elements: [] },
    { type: "audio", url: "data:audio/mpeg;base64,aGVsbG8=" },
  ]);
});

test("Codex canonical history is not replaced by a stale rollout tail", () => {
  const base = {
    sessionId: "host_1/codex/thread-audio",
    role: "assistant" as const,
    createdAt: "2026-08-23T10:00:00.000Z",
    completedAt: "2026-08-23T10:00:01.000Z",
    status: "completed" as const,
    nativeMetadata: {},
  };
  const canonical = [
    { ...base, id: "canonical-user", providerMessageId: "fresh-audio-user", role: "user" as const, parts: [{ type: "audio" as const, uri: "data:audio/mpeg;base64,AQID", mimeType: "audio/mpeg", name: "Recording.mp3" }] },
    { ...base, id: "canonical-answer", providerMessageId: "fresh-answer", createdAt: "2026-08-23T10:00:02.000Z", parts: [{ type: "text" as const, text: "Fresh answer" }] },
  ];
  const observed = [{ ...base, id: "old-rollout-answer", providerMessageId: "old-answer", createdAt: "2026-08-23T09:00:00.000Z", parts: [{ type: "text" as const, text: "Previous answer" }] }];

  const merged = mergeCodexMessageHistory(canonical, observed);
  assert.deepEqual(merged.map((message) => message.providerMessageId), ["old-answer", "fresh-audio-user", "fresh-answer"]);
});

test("Codex advertises native MP3 input for GPT-5.6 Sol", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("model/list", {
    data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", inputModalities: ["text", "image"] }],
    nextCursor: null,
  });

  const models = await adapter.listModels();

  assert.deepEqual(models[0]?.inputModalities, ["text", "image", "audio"]);
  await adapter.dispose();
});

test("Codex compaction uses the native app-server thread command", async () => {
  const { adapter, transport } = await adapterWithPeer();

  await adapter.compactSession("thread-context-limit");

  const request = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/compact/start"
  ) as Record<string, unknown> | undefined;
  assert.ok(request);
  assert.deepEqual(request.params, { threadId: "thread-context-limit" });
  await adapter.dispose();
});

test("Codex context occupancy uses the current window rather than lifetime token totals after compaction", async () => {
  const { adapter, transport } = await adapterWithPeer();

  transport.push({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-context-limit",
      tokenUsage: {
        total: { inputTokens: 90_282_122, cachedInputTokens: 86_824_832, outputTokens: 278_111, totalTokens: 90_560_233 },
        last: { inputTokens: 27_900, cachedInputTokens: 25_600, outputTokens: 34, totalTokens: 27_934 },
        modelContextWindow: 258_400,
      },
    },
  });
  await delay(5);

  const context = await adapter.getSessionContext("thread-context-limit");
  assert.equal(context.usedTokens, 27_934);
  assert.equal(context.usedPercent, 27_934 / 258_400 * 100);
  assert.deepEqual(context.usage, {
    inputTokens: 27_900,
    outputTokens: 34,
    cacheReadTokens: 25_600,
    totalTokens: 27_934,
  });
  await adapter.dispose();
});

test("Codex forwards next-turn model, effort, and phone image data", async () => {
  const { adapter, transport, events } = await adapterWithPeer();

  await adapter.sendMessage("thread-1", {
    requestId: "phone-turn-1",
    content: "Inspect this screenshot",
    modelId: "gpt-5.6",
    reasoningEffort: "high",
    attachments: [{ name: "screen.jpg", mimeType: "image/jpeg", dataBase64: "AQID", byteLength: 3 }],
  });

  const request = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "turn/start"
  ) as Record<string, unknown> | undefined;
  assert.ok(request);
  assert.deepEqual(request.params, {
    threadId: "thread-1",
    clientUserMessageId: "phone-turn-1",
    input: [
      { type: "text", text: "Inspect this screenshot", text_elements: [] },
      { type: "image", url: "data:image/jpeg;base64,AQID" },
    ],
    model: "gpt-5.6",
    effort: "high",
  });

  const initialize = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "initialize"
  ) as Record<string, unknown> | undefined;
  assert.ok(initialize);
  assert.deepEqual(initialize.params, {
    clientInfo: { name: "tethoq", title: "Tethoq", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });

  const metadataEvents = events.filter((event) => event.type === "session.updated");
  assert.deepEqual(metadataEvents.map((event) => event.payload), [{ modelId: "gpt-5.6", reasoningEffort: "high" }]);

  await adapter.dispose();
});

test("Codex resumes a persisted thread and retries once when turn start cannot find it", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("turn/start", [
    { error: { code: -32600, message: "thread not found: thread-persisted" } },
    { result: { turn: { id: "turn-after-resume" } } },
  ]);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-persisted" } });

  const result = await adapter.sendMessage("thread-persisted", {
    requestId: "persisted-send-1",
    content: "Continue this task",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
  });

  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null &&
    ["turn/start", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["turn/start", "thread/resume", "turn/start"]);
  assert.deepEqual(calls[0]?.params, calls[2]?.params, "the retry must preserve the original request id and content");
  assert.deepEqual(calls[1]?.params, { threadId: "thread-persisted" });
  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-after-resume", details: [] });
  await adapter.dispose();
});

test("Codex preserves a genuine missing-thread failure after the single resume attempt", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("turn/start", [
    { error: { code: -32600, message: "thread not found: thread-deleted" } },
  ]);
  transport.methodResponses.set("thread/resume", [
    { error: { code: -32600, message: "thread not found: thread-deleted" } },
  ]);

  await assert.rejects(
    adapter.sendMessage("thread-deleted", { requestId: "deleted-send-1", content: "Continue this task" }),
    /thread not found: thread-deleted/iu,
  );
  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null &&
    ["turn/start", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["turn/start", "thread/resume"]);
  await adapter.dispose();
});
test("Codex exposes scoped client tools on new sessions and routes calls through the bridge tooling", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/start", { thread: { id: "thread-tools", preview: "Tools", status: { type: "idle" }, createdAt: 1, updatedAt: 1, cwd: "C:\\workspace" } });
  const calls: unknown[] = [];
  const tooling: ProviderClientTooling = {
    definitions: [{ name: "mesh_list_children", description: "List children", inputSchema: { type: "object" } }],
    async execute(providerId, providerSessionId, tool, input) {
      calls.push({ providerId, providerSessionId, tool, input });
      return { children: [] };
    },
    mcpServer() { throw new Error("not used"); },
  };
  adapter.configureClientTooling(tooling);
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const start = transport.sent.find((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/start") as Record<string, unknown>;
  assert.deepEqual((start.params as Record<string, unknown>).dynamicTools, [{
    type: "function",
    name: "mesh_list_children",
    description: "List children",
    inputSchema: { type: "object" },
  }]);

  transport.push({ id: "tool-call-one", method: "item/tool/call", params: { threadId: "thread-tools", tool: "mesh_list_children", arguments: {} } });
  await delay(10);
  assert.deepEqual(calls, [{ providerId: "codex", providerSessionId: "thread-tools", tool: "mesh_list_children", input: {} }]);
  assert.deepEqual(sentResult(transport, "tool-call-one"), { contentItems: [{ type: "inputText", text: "{\"children\":[]}" }], success: true });
  await adapter.dispose();
});

test("Codex creates an isolated eyes session with hidden guidance and no client or MCP tools", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/start", { thread: { id: "thread-eyes", preview: "", status: { type: "idle" }, createdAt: 1, updatedAt: 1, cwd: "C:\\workspace" } });
  adapter.configureClientTooling({
    definitions: [{ name: "ask_eyes", description: "Visual support", inputSchema: { type: "object" } }],
    async execute() { return {}; },
    mcpServer() { throw new Error("not used"); },
  });
  await adapter.createSession({
    workingDirectory: "C:\\workspace",
    modelId: "gpt-vision",
    developerInstructions: "Act only as visual support.",
    ephemeral: true,
    clientTools: "none",
    mcpServers: "none",
  });
  const start = transport.sent.find((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/start") as Record<string, unknown>;
  assert.deepEqual(start.params, {
    cwd: "C:\\workspace",
    model: "gpt-vision",
    developerInstructions: "Act only as visual support.",
    ephemeral: true,
    config: { mcp_servers: {} },
  });
  await adapter.dispose();
});

test("Codex branches with the documented thread fork API without starting a turn", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/fork", {
    thread: {
      id: "thread-forked",
      sessionId: "thread-forked",
      forkedFromId: "thread-source",
      preview: "Copied history",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" },
      cwd: "C:\\workspace",
      cliVersion: "test",
      turns: [],
    },
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    cwd: "C:\\workspace",
  });

  const session = await adapter.branchSession("thread-source");
  const fork = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/fork"
  ) as Record<string, unknown> | undefined;
  assert.deepEqual(fork?.params, { threadId: "thread-source" });
  assert.equal(session.providerSessionId, "thread-forked");
  assert.equal(session.modelId, "gpt-5.6-sol");
  assert.equal(session.reasoningEffort, "high");
  assert.deepEqual(session.relationship, {
    kind: "branch",
    sourceSessionId: "host_1/codex/thread-source",
    strategy: "native",
  });
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "turn/start"), false);
  await adapter.dispose();
});

test("Codex edits a stopped plain-text message by rolling back exact turns before restarting", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/read", {
    thread: {
      id: "thread-edit",
      sessionId: "thread-edit",
      preview: "Edit test",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" },
      cwd: "C:\\work",
      cliVersion: "0.147.0",
      turns: [
        { id: "turn-1", status: "completed", items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "First" }] }] },
        { id: "turn-2", status: "interrupted", items: [{ type: "userMessage", id: "user-2", content: [{ type: "text", text: "Original" }] }] },
        { id: "turn-3", status: "completed", items: [{ type: "userMessage", id: "user-3", content: [{ type: "text", text: "Later" }] }] },
      ],
    },
  });
  transport.methodResults.set("thread/rollback", { thread: { id: "thread-edit", turns: [] } });
  transport.methodResults.set("turn/start", { turn: { id: "replacement-turn" } });

  const result = await adapter.editMessage("thread-edit", {
    requestId: "edit-request",
    providerMessageId: "user-2",
    content: "Edited instruction",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
  });

  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null &&
    ["thread/read", "thread/rollback", "turn/start"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/read", "thread/rollback", "turn/start"]);
  assert.deepEqual(calls[1]?.params, { threadId: "thread-edit", numTurns: 2 });
  assert.deepEqual(calls[2]?.params, {
    threadId: "thread-edit",
    clientUserMessageId: "edit-request",
    input: [{ type: "text", text: "Edited instruction", text_elements: [] }],
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.equal(result.providerTurnId, "replacement-turn");
  await adapter.dispose();
});

test("Codex child-session listing uses the experimental parentThreadId filter only when requested", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/list", { data: [], nextCursor: null });

  await adapter.listSessions();
  await adapter.listSessions({ parentProviderSessionId: "parent-thread" });
  const requests = transport.sent.filter((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/list"
  ) as Record<string, unknown>[];
  assert.deepEqual(requests.map((request) => request.params), [
    { archived: false },
    { parentThreadId: "parent-thread", archived: false },
  ]);
  await adapter.dispose();
});

test("Codex rollout metadata enriches listed sessions and emits normalized live updates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-adapter-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, [
    `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-initial", effort: "medium" } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-15T13:15:00.000Z", type: "response_item", payload: { type: "reasoning", id: "reason-live", summary: [{ type: "summary_text", text: "Checking the live state" }] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-15T13:15:01.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 390_000, cached_input_tokens: 380_000, output_tokens: 9_748, total_tokens: 399_748 }, model_context_window: 1_000_000 } } })}\n`,
  ].join(""), "utf8");
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: "desktop-thread",
      sessionId: "desktop-thread",
      preview: "Desktop thread",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "notLoaded" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    }],
    nextCursor: null,
  });
  const events: ProviderEvent[] = [];
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: { codexHome: directory, pollIntervalMs: 10, isLockHeld: async () => true },
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });

  const page = await adapter.listSessions();
  assert.equal(page.sessions[0]?.state, "working");
  assert.equal(page.sessions[0]?.modelId, "gpt-initial");
  assert.equal(page.sessions[0]?.reasoningEffort, "medium");
  assert.deepEqual(events.filter((event) => event.type === "session.updated"), []);
  const context = await adapter.getSessionContext("desktop-thread");
  assert.equal(context.usedTokens, 399_748);
  assert.equal(context.contextWindowTokens, 1_000_000);
  assert.equal(context.usedPercent, 39.9748);
  const messages = await adapter.getMessages("desktop-thread");
  assert.equal(messages.at(-1)?.status, "streaming");
  assert.equal(messages.at(-1)?.parts[0]?.type, "reasoning");

  await appendFile(rollout, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-current", reasoning_effort: "high" } })}\n`, "utf8");
  const deadline = Date.now() + 500;
  while (events.every((event) => event.type !== "session.updated") && Date.now() < deadline) await delay(10);
  const update = events.find((event) => event.type === "session.updated");
  assert.equal(update?.providerSessionId, "desktop-thread");
  assert.deepEqual(update?.payload, { modelId: "gpt-current", reasoningEffort: "high" });
  assert.equal(update?.nativeEvent, undefined);
});

test("Codex includes an externally active locked thread even when thread list omits it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-active-list-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const activeId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "rollout.jsonl");
  await mkdir(join(directory, "thread-writer-locks"), { recursive: true });
  await writeFile(join(directory, "thread-writer-locks", `${activeId}.lock`), "");
  await writeFile(rollout, [
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-15T13:52:33.000Z", type: "response_item", payload: { type: "message", id: "current-user-message", role: "user", content: [{ type: "input_text", text: "Also, this chat itself is not showing up in that session list." }] } })}\n`,
  ].join(""), "utf8");
  const thread = {
    id: activeId,
    sessionId: activeId,
    preview: "Active external task",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "active" },
    path: rollout,
    cwd: directory,
    cliVersion: "0.147.0",
  };
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", { data: [], nextCursor: null });
  transport.methodResults.set("thread/read", { thread });
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, localActivity: { codexHome: directory } });
  t.after(() => adapter.dispose());

  const page = await adapter.listSessions();
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0]?.providerSessionId, activeId);
  assert.equal(page.sessions[0]?.state, "working");
  assert.equal(page.sessions[0]?.externalWriter, true);
  assert.equal(page.sessions[0]?.preview, "Also, this chat itself is not showing up in that session list.");
  assert.equal(page.sessions[0]?.lastActivityAt, "2026-08-15T13:52:33.000Z");
});

test("Codex marks an idle not-loaded thread as externally owned only while its writer lock exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-idle-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "rollout.jsonl");
  const lockDirectory = join(directory, "thread-writer-locks");
  const lockPath = join(lockDirectory, `${threadId}.lock`);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(lockPath, "");
  await writeFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`, "utf8");
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: threadId,
      sessionId: threadId,
      preview: "Idle Desktop task",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "notLoaded" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    }],
    nextCursor: null,
  });
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, localActivity: { codexHome: directory } });
  t.after(() => adapter.dispose());

  const locked = (await adapter.listSessions()).sessions[0];
  assert.equal(locked?.state, "idle", "writer ownership must not make an idle task look busy");
  assert.equal(locked?.externalWriter, true);

  await rm(lockPath);
  const unlocked = (await adapter.listSessions()).sessions[0];
  assert.equal(unlocked?.state, "idle");
  assert.equal(unlocked?.externalWriter, undefined);
});

test("Codex does not mistake its own loaded writer for an external Desktop owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-owned-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`, "utf8");
  const thread = {
    id: threadId,
    sessionId: threadId,
    preview: "Locally resumed task",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: rollout,
    cwd: directory,
    cliVersion: "0.147.0",
  };
  const transport = new FakeTransport();
  transport.methodResults.set("thread/resume", { thread });
  transport.methodResults.set("thread/list", { data: [thread], nextCursor: null });
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    idleReleaseMs: 5,
    localActivity: { codexHome: directory, isLockHeld: async () => true },
  });
  t.after(() => adapter.dispose());

  await adapter.resumeSession(threadId);
  assert.equal((await adapter.listSessions()).sessions[0]?.externalWriter, undefined);

  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal((await adapter.listSessions()).sessions[0]?.externalWriter, true, "ownership clears when Tethoq releases its App Server");
});

test("Codex approval responses match each server request kind", async () => {
  const { adapter, transport } = await adapterWithPeer();

  // 1. command execution requestApproval -> decision accept/decline
  const cmdId = "req_cmd";
  transport.push({ id: cmdId, method: "item/commandExecution/requestApproval", params: { threadId: "t1", turnId: "tu1", itemId: "i1", command: "npm test", cwd: "C:\\w", reason: "run tests" } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: cmdId, choiceId: "approve" });
  await delay(25);
  assert.deepEqual(sentResult(transport, cmdId), { decision: "accept" });

  // 2. file change requestApproval -> decision accept/decline
  const fileId = "req_file";
  transport.push({ id: fileId, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "tu1", itemId: "i2", reason: "write" } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: fileId, choiceId: "reject" });
  await delay(25);
  assert.deepEqual(sentResult(transport, fileId), { decision: "decline" });

  // 3. legacy applyPatchApproval -> ReviewDecision approved / denied
  const patchId = "req_patch";
  transport.push({ id: patchId, method: "applyPatchApproval", params: { conversationId: "t1", callId: "c1", fileChanges: { "a.ts": {} }, reason: null, grantRoot: null } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: patchId, choiceId: "approve" });
  await delay(25);
  assert.deepEqual(sentResult(transport, patchId), { decision: "approved" });

  const execId = "req_exec";
  transport.push({ id: execId, method: "execCommandApproval", params: { conversationId: "t1", callId: "c2", approvalId: null, command: ["git", "push"], cwd: "C:\\w", reason: "push", parsedCmd: [] } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: execId, choiceId: "reject" });
  await delay(25);
  const execResult = sentResult(transport, execId) as { decision: unknown };
  assert.ok(execResult && typeof execResult.decision === "object" && execResult.decision !== null);
  assert.ok("denied" in (execResult.decision as Record<string, unknown>));

  // 4. permissions requestApproval -> granted profile + turn scope; reject grants nothing
  const permId = "req_perm";
  transport.push({ id: permId, method: "item/permissions/requestApproval", params: { threadId: "t1", turnId: "tu1", itemId: "i3", cwd: "C:\\w", reason: "more access", permissions: { network: { enabled: true }, fileSystem: { read: ["C:\\a"], write: null } } } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: permId, choiceId: "approve" });
  await delay(25);
  assert.deepEqual(sentResult(transport, permId), { permissions: { network: { enabled: true }, fileSystem: { read: ["C:\\a"] } }, scope: "turn" });

  const permRejectId = "req_perm_reject";
  transport.push({ id: permRejectId, method: "item/permissions/requestApproval", params: { threadId: "t1", turnId: "tu1", itemId: "i4", cwd: "C:\\w", reason: null, permissions: { network: { enabled: true }, fileSystem: null } } });
  await delay(25);
  await adapter.respondToApproval({ providerRequestId: permRejectId, choiceId: "reject" });
  await delay(25);
  assert.deepEqual(sentResult(transport, permRejectId), { permissions: {}, scope: "turn" });

  await adapter.dispose();
});

test("Codex user-input responses are normalized into the native answers shape", async () => {
  const { adapter, transport } = await adapterWithPeer();
  const inputId = "req_input";
  transport.push({ id: inputId, method: "item/tool/requestUserInput", params: { threadId: "t1", turnId: "tu1", itemId: "i1", questions: [{ id: "q1", header: "Choose", question: "Which?", isOther: false, isSecret: false, options: [] }], isBlocking: true, autoResolutionMs: null } });
  await delay(25);
  await adapter.respondToUserInput({ providerRequestId: inputId, answers: { q1: ["a", "b"] } });
  await delay(25);
  assert.deepEqual(sentResult(transport, inputId), { answers: { q1: { answers: ["a", "b"] } } });
  await adapter.dispose();
});

test("Codex rejects an unknown server request instead of pretending success", async () => {
  const { adapter, transport } = await adapterWithPeer();
  const id = "req_unknown";
  transport.push({ id, method: "attestation/generate", params: {} });
  await delay(25);
  const response = transport.sent.find((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    return record.id === id && "error" in record;
  });
  assert.ok(response !== undefined, "expected an error response for unsupported server request");
  const error = (response as Record<string, unknown>).error as Record<string, unknown>;
  assert.ok(String(error.message).includes("unsupported"));
  await adapter.dispose();
});

test("Codex status notifications emit canonical state only on transitions", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active" } } });
  await delay(25);
  transport.push({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active" } } });
  await delay(25);
  transport.push({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  await delay(25);

  const statuses = events.filter((event) => event.type === "session.status_changed");
  assert.deepEqual(statuses.map((event) => event.payload.state), ["working", "idle"]);
  assert.equal(statuses[0]?.payload.threadId, "t1");
  await adapter.dispose();
});

test("Codex live notifications type known activity and ignore unknown structured traces", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({ method: "item/completed", params: { threadId: "t1", item: { id: "raw-1", type: "providerBrowserSnapshot", text: "full raw DOM trace", nodes: [{ id: 1 }] } } });
  transport.push({ method: "item/completed", params: { threadId: "t1", item: { id: "reason-1", type: "reasoning", summary: "Checking the current state" } } });
  transport.push({ method: "item/completed", params: { threadId: "t1", item: { id: "file-1", type: "fileChange", changes: [{ path: "README.md" }] } } });
  transport.push({ method: "item/completed", params: { threadId: "t1", item: { id: "compact-1", type: "contextCompaction", summary: { raw: "provider envelope" } } } });
  transport.push({ method: "warning", params: { threadId: "t1", message: "Long threads may be less accurate." } });
  await delay(25);

  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("full raw DOM trace")), false);
  assert.equal(events.some((event) => event.type === "message.completed" && event.payload.partType === "reasoning"), true);
  assert.equal(events.some((event) => event.type === "file.changed"), true);
  assert.equal(events.some((event) => event.type === "message.completed" && event.payload.text === "Session compacted"), true);
  assert.equal(events.some((event) => event.type === "agent.error"), false, "an informational warning must not fail a successful compaction");
  await adapter.dispose();
});

test("Codex surfaces rejected JSON-RPC callbacks as a provider connection event", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  await adapter.subscribe(null, async (event) => {
    if (event.type === "session.status_changed") throw new Error("callback failed");
  });

  transport.push({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active" } } });
  await delay(25);

  const disconnected = events.find((event) => event.type === "provider.disconnected");
  assert.deepEqual(disconnected?.payload, { message: "callback failed", source: "json_rpc_callback" });
  await adapter.dispose();
});

test("foreign rollout messages flow through canonical provider events without history replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-adapter-messages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const historical = JSON.stringify({
    type: "response_item",
    payload: { type: "message", id: "old", role: "assistant", content: [{ type: "output_text", text: "historical" }] },
  });
  await writeFile(rollout, `${JSON.stringify({ type: "turn_context" })}\n${historical}\n`, "utf8");

  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: "foreign-thread",
      sessionId: "foreign-thread",
      preview: "Foreign thread",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "notLoaded" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    }],
    nextCursor: null,
  });
  const events: ProviderEvent[] = [];
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: {
      codexHome: directory,
      pollIntervalMs: 10,
      isLockHeld: async () => true,
    },
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.listSessions();
  await delay(25);
  assert.deepEqual(events.filter((event) => event.type.startsWith("message.")), []);

  const appended = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      id: "assistant-new",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "live text" }],
    },
  });
  const toolCall = JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", id: "tool-item", call_id: "tool-call", name: "view_image", status: "completed", input: "preview.png" },
  });
  const toolResult = JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call_output", id: "tool-result", call_id: "tool-call", output: "image opened" },
  });
  await appendFile(rollout, `${appended}\n${toolCall}\n${toolResult}\n`, "utf8");
  const deadline = Date.now() + 500;
  while ((events.filter((event) => event.type.startsWith("message.")).length < 1 || events.every((event) => event.type !== "tool.completed")) && Date.now() < deadline) await delay(10);

  const messages = events.filter((event) => event.type.startsWith("message."));
  assert.deepEqual(messages.map((event) => event.type), ["message.completed"]);
  assert.deepEqual(messages.map((event) => event.providerSessionId), ["foreign-thread"]);
  assert.deepEqual(messages[0]?.payload, {
    messageId: "assistant-new",
    role: "assistant",
    partType: "text",
    source: "codex-local-rollout",
    phase: "commentary",
    text: "live text",
  });
  const toolEvents = events.filter((event) => event.type.startsWith("tool."));
  assert.deepEqual(toolEvents.map((event) => event.type), ["tool.completed", "tool.completed"]);
  assert.deepEqual(toolEvents[0]?.payload, {
    callId: "tool-call",
    name: "view_image",
    input: "preview.png",
    source: "codex-local-rollout",
  });
  assert.deepEqual(toolEvents[1]?.payload, {
    callId: "tool-call",
    name: "view_image",
    input: "preview.png",
    output: "image opened",
    source: "codex-local-rollout",
  });
  assert.equal(messages.some((event) => event.nativeEvent !== undefined), false, "raw rollout records must not be exposed");
});
