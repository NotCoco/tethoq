import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "./codex_adapter.js";
import type { JsonRpcTransport, ProviderClientTooling, ProviderEvent } from "../../provider_contract/src/index.js";

class FakeTransport implements JsonRpcTransport {
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();
  readonly methodResults = new Map<string, unknown>();
  public async send(message: unknown): Promise<void> {
    this.sent.push(message);
    // Auto-respond to client requests so peer initialization completes.
    if (typeof message === "object" && message !== null) {
      const record = message as Record<string, unknown>;
      if (typeof record.id === "string" || typeof record.id === "number") {
        if (typeof record.method === "string" && !("result" in record) && !("error" in record)) {
          const id = record.id;
          const result = this.methodResults.has(record.method)
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
  public async close(): Promise<void> {}
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
  assert.equal(standard.cancelQueuedMessage, undefined);
  assert.equal(typeof synchronized.listQueuedMessages, "function");
  assert.equal(typeof synchronized.enqueueQueuedMessage, "function");
  assert.equal(typeof synchronized.cancelQueuedMessage, "function");
  standard.dispose();
  synchronized.dispose();
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
  await writeFile(rollout, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-initial", effort: "medium" } })}\n`, "utf8");
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
  assert.equal(page.sessions[0]?.modelId, "gpt-initial");
  assert.equal(page.sessions[0]?.reasoningEffort, "medium");
  assert.deepEqual(events.filter((event) => event.type === "session.updated"), []);

  await appendFile(rollout, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-current", reasoning_effort: "high" } })}\n`, "utf8");
  const deadline = Date.now() + 500;
  while (events.every((event) => event.type !== "session.updated") && Date.now() < deadline) await delay(10);
  const update = events.find((event) => event.type === "session.updated");
  assert.equal(update?.providerSessionId, "desktop-thread");
  assert.deepEqual(update?.payload, { modelId: "gpt-current", reasoningEffort: "high" });
  assert.equal(update?.nativeEvent, undefined);
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
  await delay(25);

  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("full raw DOM trace")), false);
  assert.equal(events.some((event) => event.type === "message.completed" && event.payload.partType === "reasoning"), true);
  assert.equal(events.some((event) => event.type === "file.changed"), true);
  assert.equal(events.some((event) => event.type === "message.completed" && event.payload.text === "Context compacted"), true);
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
  await appendFile(rollout, `${appended}\n`, "utf8");
  const deadline = Date.now() + 500;
  while (events.filter((event) => event.type.startsWith("message.")).length < 3 && Date.now() < deadline) await delay(10);

  const messages = events.filter((event) => event.type.startsWith("message."));
  assert.deepEqual(messages.map((event) => event.type), ["message.started", "message.delta", "message.completed"]);
  assert.deepEqual(messages.map((event) => event.providerSessionId), ["foreign-thread", "foreign-thread", "foreign-thread"]);
  assert.deepEqual(messages[0]?.payload, {
    messageId: "assistant-new",
    role: "assistant",
    partType: "text",
    source: "codex-local-rollout",
    phase: "commentary",
  });
  assert.deepEqual(messages[1]?.payload, {
    messageId: "assistant-new",
    role: "assistant",
    partType: "text",
    source: "codex-local-rollout",
    phase: "commentary",
    text: "live text",
  });
  assert.deepEqual(messages[2]?.payload, messages[0]?.payload);
  assert.equal(messages.some((event) => event.nativeEvent !== undefined), false, "raw rollout records must not be exposed");
});
