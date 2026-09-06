import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ProviderAdapterError, type JsonRpcTransport, type ProviderEvent } from "../../provider_contract/src/index.js";
import {
  createPublicAcpProviderAdapter,
  GrokProviderAdapter,
  PUBLIC_ACP_PROVIDER_PRESETS,
  reportedModelSelection,
} from "./grok_adapter.js";

class FakeTransport implements JsonRpcTransport {
  readonly listeners = new Set<(message: unknown) => void>();
  readonly closeListeners = new Set<(error: Error) => void>();
  readonly methodResults = new Map<string, unknown>();
  readonly notificationsBeforeResult = new Map<string, readonly unknown[]>();
  readonly blockedMethods = new Set<string>();
  readonly rejectedMethods = new Map<string, Error>();
  readonly sent: unknown[] = [];
  public closeCalls = 0;
  public transportError: Error | undefined;

  public async send(message: unknown): Promise<void> {
    if (this.transportError !== undefined) throw this.transportError;
    this.sent.push(message);
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if ((typeof record.id !== "string" && typeof record.id !== "number") || typeof record.method !== "string") return;
    const rejected = this.rejectedMethods.get(record.method);
    if (rejected !== undefined) throw rejected;
    if (this.blockedMethods.has(record.method)) return;
    const result = this.methodResults.get(record.method) ?? {};
    for (const notification of this.notificationsBeforeResult.get(record.method) ?? []) this.push(notification);
    setTimeout(() => this.push({ id: record.id, result }), 1);
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public async close(): Promise<void> { this.closeCalls += 1; }

  public crash(error = new Error("Grok transport disconnected")): void {
    this.transportError = error;
    for (const listener of [...this.closeListeners]) listener(error);
  }

  public push(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }
}

async function waitForSentMethod(transport: FakeTransport, method: string): Promise<Record<string, unknown>> {
  for (;;) {
    const request = transport.sent.find((message) => typeof message === "object" && message !== null
      && (message as Record<string, unknown>).method === method);
    if (request !== undefined) return request as Record<string, unknown>;
    await delay(1);
  }
}

async function waitForSentMethodCount(transport: FakeTransport, method: string, count: number): Promise<void> {
  for (;;) {
    const actual = transport.sent.filter((message) => typeof message === "object" && message !== null
      && (message as Record<string, unknown>).method === method).length;
    if (actual >= count) return;
    await delay(1);
  }
}

function interactionResult(transport: FakeTransport, id: string): unknown {
  const response = transport.sent.find((value): value is { id: string; result: unknown } =>
    typeof value === "object" && value !== null && "id" in value && value.id === id && "result" in value);
  return response === undefined ? undefined : JSON.parse(JSON.stringify(response.result));
}

for (const method of ["x.ai/ask_user_question", "_x.ai/ask_user_question"]) {
  test(`Grok ${method} returns native question-keyed answers, multiSelect arrays, and Other annotations`, async (t) => {
    const transport = new FakeTransport();
    transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
    const events: ProviderEvent[] = [];
    const adapter = new GrokProviderAdapter({ hostId: "grok-question-test", transportFactory: () => transport });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, (event) => { events.push(event); });
    const questions = [
      { question: "Which database?", options: [{ label: "Redis", description: "Cache", preview: "Redis preview" }, { label: "Postgres", description: "Database" }] },
      { question: "Which storage?", options: [{ label: "Local", description: "Local files" }] },
      { question: "Which checks?", multiSelect: true, options: [{ label: "Tests", description: "Run tests" }, { label: "Build", description: "Compile" }] },
      { question: "Which extra checks?", multiSelect: true, options: [{ label: "Lint", description: "Lint", preview: "must not be sent for multiSelect" }] },
    ];
    transport.push({ id: "question-rpc", method, params: { sessionId: "question-task", toolCallId: "question-tool", mode: "default", questions } });
    await delay(10);
    const request = events.find((event) => event.type === "user_input.requested");
    assert.equal(request?.providerSessionId, "question-task");
    const renderedQuestions = (request?.payload.request as Record<string, unknown>).questions as Record<string, unknown>[];
    assert.deepEqual(renderedQuestions.map((entry) => entry.id), ["question_0", "question_1", "question_2", "question_3"]);
    assert.equal(renderedQuestions[2]?.multiSelect, true);
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: "question-rpc", answers: { question_0: "Redis" } }), /every question/);
    assert.equal(interactionResult(transport, "question-rpc"), undefined);
    await adapter.respondToUserInput({ providerRequestId: "question-rpc", answers: {
      question_3: ["Lint"], question_2: ["Build", "Tests"], question_1: "Use cloud storage", question_0: { answers: ["Redis"] },
    } });
    await delay(10);
    assert.deepEqual(interactionResult(transport, "question-rpc"), {
      outcome: "accepted",
      answers: { "Which database?": ["Redis"], "Which storage?": ["Other"], "Which checks?": ["Build", "Tests"], "Which extra checks?": ["Lint"] },
      annotations: { "Which database?": { preview: "Redis preview" }, "Which storage?": { notes: "Use cloud storage" } },
    });
    assert.ok(events.some((event) => event.type === "user_input.resolved" && event.payload.providerRequestId === "question-rpc"));
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: "question-rpc", answers: { question_0: "Redis" } }), /no longer/);
  });
}

test("Grok interaction_resolved uses native snake_case identity and preserves another task's question", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "grok-external-answer", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  for (const sessionId of ["resolved-task", "other-task"]) {
    transport.push({ id: `${sessionId}-input`, method: "x.ai/ask_user_question", params: {
      sessionId, toolCallId: "same-tool-id", mode: "default", questions: [{ question: "Which option?", options: [{ label: "Yes", description: "Proceed" }] }],
    } });
  }
  await delay(10);
  transport.push({ method: "x.ai/session_notification", params: { sessionId: "resolved-task", update: { sessionUpdate: "interaction_resolved", tool_call_id: "wrong-tool" } } });
  await delay(10);
  assert.equal(events.some((event) => event.type === "user_input.resolved"), false);
  transport.push({ method: "_x.ai/session_notification", params: { sessionId: "resolved-task", update: { sessionUpdate: "interaction_resolved", tool_call_id: "same-tool-id" } } });
  await delay(10);
  assert.deepEqual(interactionResult(transport, "resolved-task-input"), { outcome: "cancelled" });
  assert.equal(interactionResult(transport, "other-task-input"), undefined);
  assert.deepEqual(events.filter((event) => event.type === "user_input.resolved").map((event) => event.payload), [{ providerRequestId: "resolved-task-input", reason: "cancelled" }]);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "resolved-task-input", answers: { question_0: "Yes" } }), /no longer/);
  await adapter.respondToUserInput({ providerRequestId: "other-task-input", answers: { question_0: "Yes" } });
});

test("Grok transport disconnect retires native questions and forms without a local prompt", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "question-disconnect-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({ id: "native-question", method: "x.ai/ask_user_question", params: {
    sessionId: "native-task", toolCallId: "question-tool", mode: "default", questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
  } });
  transport.push({ id: "native-form", method: "x.ai/mcp/elicit", params: {
    sessionId: "form-task", toolCallId: "form-tool", mode: "form", serverName: "Workspace", message: "Enter a label",
    requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  } });
  await delay(10);
  assert.equal(events.filter((event) => event.type === "user_input.requested").length, 2);
  transport.crash();
  await delay(10);
  assert.deepEqual(events.filter((event) => event.type === "user_input.resolved").map((event) => ({ sessionId: event.providerSessionId, ...event.payload })), [
    { sessionId: "native-task", providerRequestId: "native-question", reason: "cancelled" },
    { sessionId: "form-task", providerRequestId: "native-form", reason: "cancelled" },
  ]);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "native-question", answers: { question_0: "Yes" } }), /no longer/);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "native-form", answers: { action: "accept", content: { label: "QA" } } }), /no longer/);
  assert.ok(events.some((event) => event.type === "provider.disconnected" && event.payload.source === "transport_closed"));
  assert.equal(events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted"), false);
});

test("Grok transport disconnect retires questions when an active tool defers the prompt terminal", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "deferred-question" });
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "deferred-disconnect-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\fixture" });
  await adapter.sendMessage("deferred-question", { requestId: "prompt", content: "Inspect" });
  await waitForSentMethod(transport, "session/prompt");
  transport.push({ method: "session/update", params: { sessionId: "deferred-question", update: {
    sessionUpdate: "tool_call", toolCallId: "pending-tool", title: "Question", status: "in_progress",
  } } });
  transport.push({ id: "deferred-input", method: "x.ai/ask_user_question", params: {
    sessionId: "deferred-question", toolCallId: "pending-tool", mode: "default", questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
  } });
  await delay(10);
  assert.ok(events.some((event) => event.type === "user_input.requested"));
  transport.crash();
  await delay(10);
  assert.deepEqual(events.filter((event) => event.type === "user_input.resolved").map((event) => event.payload), [
    { providerRequestId: "deferred-input", reason: "cancelled" },
  ]);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "deferred-input", answers: { question_0: "Yes" } }), /no longer/);
  assert.ok(events.some((event) => event.type === "provider.disconnected" && event.payload.source === "transport_closed"));
  assert.equal(events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error"), false,
    "request cleanup must not invent a terminal event while native work owns the session");
});

test("Grok intentional idle release stays silent and late close callbacks preserve newer questions", async (t) => {
  const transports: FakeTransport[] = [];
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({
    hostId: "question-idle-release-test", idleReleaseMs: 5,
    transportFactory: () => {
      const transport = new FakeTransport();
      transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
      transports.push(transport);
      return transport;
    },
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  const oldTransport = transports[0]!;
  const lateCloseCallbacks = [...oldTransport.closeListeners];
  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal(oldTransport.closeCalls, 1);
  assert.equal(events.some((event) => event.type === "provider.disconnected"), false);

  await adapter.subscribe(null, () => undefined);
  const newTransport = transports[1]!;
  assert.ok(newTransport, "the next use must initialize a fresh peer");
  newTransport.push({ id: "new-question", method: "x.ai/ask_user_question", params: {
    sessionId: "new-task", toolCallId: "new-tool", mode: "default", questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
  } });
  await delay(10);
  assert.ok(events.some((event) => event.type === "user_input.requested"));
  for (const callback of lateCloseCallbacks) callback(new Error("Old process closed after idle release"));
  await delay(10);
  assert.equal(events.some((event) => event.type === "provider.disconnected" || event.type === "user_input.resolved"), false);
  await adapter.respondToUserInput({ providerRequestId: "new-question", answers: { question_0: "Yes" } });
  await delay(10);
  assert.deepEqual(interactionResult(newTransport, "new-question"), { outcome: "accepted", answers: { "Continue?": ["Yes"] }, annotations: {} });
  await adapter.dispose();
  assert.equal(newTransport.closeCalls, 1);
  assert.equal(events.some((event) => event.type === "provider.disconnected"), false);
});

for (const stopReason of ["cancelled", "end_turn"] as const) {
  test(`Grok ${stopReason} retires pending questions after confirmed native termination`, async (t) => {
    const transport = new FakeTransport();
    transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
    transport.methodResults.set("session/new", { sessionId: "terminal-question" });
    transport.blockedMethods.add("session/prompt");
    const events: ProviderEvent[] = [];
    const adapter = new GrokProviderAdapter({ hostId: "question-stop-test", transportFactory: () => transport });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, (event) => { events.push(event); });
    await adapter.createSession({ workingDirectory: "C:\\fixture" });
    await adapter.sendMessage("terminal-question", { requestId: "prompt", content: "Inspect" });
    const prompt = await waitForSentMethod(transport, "session/prompt");
    transport.push({ id: "pending-question", method: "x.ai/ask_user_question", params: {
      sessionId: "terminal-question", toolCallId: "pending-tool", mode: "default", questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
    } });
    await delay(10);
    const stopping = stopReason === "cancelled" ? adapter.interrupt("terminal-question") : undefined;
    if (stopping !== undefined) await waitForSentMethod(transport, "session/cancel");
    assert.equal(interactionResult(transport, "pending-question"), undefined, "a visual Stop must not invent provider termination");
    transport.push({ id: prompt.id, result: { stopReason } });
    await stopping;
    await delay(15);
    assert.deepEqual(interactionResult(transport, "pending-question"), { outcome: "cancelled" });
    assert.equal(adapter.hasActiveTurn("terminal-question"), false);
    assert.ok(events.some((event) => event.type === "user_input.resolved" && event.payload.providerRequestId === "pending-question"));
  });
}

for (const method of ["x.ai/mcp/elicit", "_x.ai/mcp/elicit"]) {
  test(`Grok ${method} uses native outcome/content for structured MCP forms`, async (t) => {
    const transport = new FakeTransport();
    transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
    const events: ProviderEvent[] = [];
    const adapter = new GrokProviderAdapter({ hostId: "grok-mcp-test", transportFactory: () => transport });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, (event) => { events.push(event); });
    transport.push({ id: "mcp-form", method, params: {
      sessionId: "mcp-task", toolCallId: "mcp-tool", mode: "form", serverName: "Workspace", message: "Enter a label",
      requestedSchema: { type: "object", properties: { label: { type: "string" }, enabled: { type: "boolean" } }, required: ["label", "enabled"] },
    } });
    await delay(10);
    assert.equal((events.find((event) => event.type === "user_input.requested")?.payload.request as Record<string, unknown>).kind, "elicitation");
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: "mcp-form", answers: { action: "accept", content: { label: "QA" } } }), /required/);
    assert.equal(interactionResult(transport, "mcp-form"), undefined);
    await adapter.respondToUserInput({ providerRequestId: "mcp-form", answers: { action: "accept", content: { label: "QA", enabled: false } } });
    await delay(10);
    assert.deepEqual(interactionResult(transport, "mcp-form"), { outcome: "accept", content: { label: "QA", enabled: false } });
    transport.push({ id: "mcp-decline", method, params: { sessionId: "mcp-task", toolCallId: "mcp-url", serverName: "Workspace", mode: "url", message: "Connect", url: "https://example.invalid", elicitationId: "native-elicit" } });
    await delay(10);
    await adapter.respondToUserInput({ providerRequestId: "mcp-decline", answers: { action: "decline" } });
    await delay(10);
    assert.deepEqual(interactionResult(transport, "mcp-decline"), { outcome: "decline" });
  });
}

test("ACP permission controls expose only advertised choices and require native config confirmation", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const config = (currentValue: string) => [{
    id: "permissions", name: "Tool permissions", category: "permission", type: "select", currentValue,
    options: [{ group: "Access", options: [{ value: "ask", name: "Ask each time", description: "Confirm tools" }, { value: "allow", name: "Allow tools" }] }],
  }, { id: "model", name: "Model", category: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a" }] }];
  transport.methodResults.set("session/new", { sessionId: "config-task", configOptions: config("ask") });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "permission-config-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.createSession({ workingDirectory: "C:\\fixture" });
  const available = await adapter.getSessionPermissions("config-task");
  assert.deepEqual(available.controls.map((control) => control.id), ["permissions"]);
  assert.deepEqual(available.controls[0]?.options, [{ value: "ask", label: "Ask each time", description: "Confirm tools" }, { value: "allow", label: "Allow tools" }]);
  await assert.rejects(adapter.setSessionPermission("config-task", "permissions", "unadvertised"), /did not offer/);
  assert.equal(transport.sent.some((value) => typeof value === "object" && value !== null && "method" in value && value.method === "session/set_config_option"), false);
  await assert.rejects(adapter.setSessionPermission("config-task", "permissions", "allow"), /did not confirm/);
  assert.equal((await adapter.getSessionPermissions("config-task")).controls[0]?.value, "ask");
  transport.methodResults.set("session/set_config_option", { configOptions: config("allow") });
  assert.equal((await adapter.setSessionPermission("config-task", "permissions", "allow")).controls[0]?.value, "allow");
  const write = transport.sent.find((value): value is { method: string; params: unknown } => typeof value === "object" && value !== null && "method" in value && value.method === "session/set_config_option");
  assert.deepEqual(write?.params, { sessionId: "config-task", configId: "permissions", value: "allow" });
  transport.methodResults.set("session/new", { sessionId: "other-config-task", configOptions: config("ask") });
  await adapter.createSession({ workingDirectory: "C:\\fixture" });
  assert.equal((await adapter.getSessionPermissions("other-config-task")).controls[0]?.value, "ask");
});

test("ACP legacy session modes remain selectable only from the harness's advertised mode list", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "legacy-mode-task", modes: {
    currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan", description: "Plan before acting" }],
  } });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "legacy-mode-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.createSession({ workingDirectory: "C:\\fixture" });
  assert.deepEqual((await adapter.getSessionPermissions("legacy-mode-task")).controls[0]?.options, [{ value: "default", label: "Default" }, { value: "plan", label: "Plan", description: "Plan before acting" }]);
  await assert.rejects(adapter.setSessionPermission("legacy-mode-task", "session_mode", "unsafe"), /did not offer/);
  const updated = await adapter.setSessionPermission("legacy-mode-task", "session_mode", "plan");
  assert.equal(updated.controls[0]?.value, "plan");
  const write = transport.sent.find((value): value is { method: string; params: unknown } => typeof value === "object" && value !== null && "method" in value && value.method === "session/set_mode");
  assert.deepEqual(write?.params, { sessionId: "legacy-mode-task", modeId: "plan" });
});

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

test("Grok ACP EYES failures complete only the correlated tool with one safe error", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "session-eyes-failure",
      update: {
        sessionUpdate: "tool_call",
        tool: "tethoq_turn_support",
        toolCallId: "internal-eyes-helper-id",
      },
    },
  });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "session-eyes-failure",
      update: {
        sessionUpdate: "tool_call_update",
        status: "failed",
        rawOutput: "429 quota exhausted for api_key=req_private C:\\private\\session https://provider.invalid/private",
        toolCallId: "internal-eyes-helper-id",
      },
    },
  });
  await delay();

  const failure = events.find((event) => event.type === "tool.completed" && event.payload.status === "failed");
  assert.match(String(failure?.payload.error), /usage limit was reached or it is temporarily rate-limited/u);
  assert.doesNotMatch(JSON.stringify(failure), /req_private|provider\.invalid|private\\\\session|internal-eyes-helper-id/u);
  assert.equal(failure?.nativeEvent, undefined);
  assert.equal(events.some((event) => event.type === "agent.error"), false, "an EYES tool failure must not fail the parent task");
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

test("Grok keeps a completed locally created session in lagging catalogues without duplicating or renaming it", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/new", { sessionId: "grok-scheduled-catalogue" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  transport.methodResults.set("session/list", { sessions: [], nextCursor: null });
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "host_schedule_catalogue", transportFactory: () => transport });
  await adapter.subscribe(null, (event) => { events.push(event); });

  const created = await adapter.createSession({
    workingDirectory: "C:\\workspace",
    title: "Scheduling QA grok exact title",
  });
  await adapter.sendMessage(created.providerSessionId, {
    requestId: "scheduled-catalogue-prompt",
    content: "Complete this scheduled task",
    metadata: { tethoqScheduledTaskId: "scheduled-catalogue-prompt" },
  });
  await delay();
  assert.ok(events.some((event) => event.type === "agent.completed" && event.providerSessionId === created.providerSessionId));

  transport.methodResults.set("session/list", { sessions: [], nextCursor: "older-page" });
  const laggingFirstPage = await adapter.listSessions();
  assert.deepEqual(laggingFirstPage.sessions, []);
  assert.equal(laggingFirstPage.authoritative, false);
  transport.methodResults.set("session/list", { sessions: [], nextCursor: null });
  const laggingLastPage = await adapter.listSessions({ cursor: "older-page" });
  assert.deepEqual(laggingLastPage.sessions.map((session) => session.providerSessionId), [created.providerSessionId]);
  assert.equal(laggingLastPage.sessions[0]?.title, "Scheduling QA grok exact title");

  transport.methodResults.set("session/list", {
    sessions: [{
      sessionId: created.providerSessionId,
      cwd: "C:\\workspace",
      title: "Grok generated a different title",
      updatedAt: "2026-08-29T12:00:00.000Z",
    }],
    nextCursor: null,
  });
  const caughtUp = await adapter.listSessions();
  assert.equal(caughtUp.sessions.filter((session) => session.providerSessionId === created.providerSessionId).length, 1);
  assert.equal(caughtUp.sessions[0]?.title, "Scheduling QA grok exact title");
  assert.equal(caughtUp.sessions[0]?.nativeMetadata.title, "Grok generated a different title");

  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: created.providerSessionId, cwd: "C:\\workspace", title: "Another generated title" }],
    nextCursor: "confirmed-tail",
  });
  const confirmedFirstPage = await adapter.listSessions();
  transport.methodResults.set("session/list", { sessions: [], nextCursor: null });
  const confirmedLastPage = await adapter.listSessions({ cursor: "confirmed-tail" });
  assert.equal([
    ...confirmedFirstPage.sessions,
    ...confirmedLastPage.sessions,
  ].filter((session) => session.providerSessionId === created.providerSessionId).length, 1);

  assert.deepEqual((await adapter.listSessions({ workingDirectory: "C:\\different-workspace" })).sessions, []);
  transport.methodResults.set("session/new", { sessionId: "grok-explicitly-removed" });
  const removable = await adapter.createSession({
    workingDirectory: "C:\\workspace",
    title: "Removed before Grok lists it",
  });
  transport.push({
    method: "_x.ai/sessions/changed",
    params: { removed: [removable.providerSessionId] },
  });
  await delay();
  assert.deepEqual((await adapter.listSessions()).sessions, []);
  await adapter.dispose();
});

test("Grok still adopts native generated titles for ordinary locally created sessions", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true } },
  });
  transport.methodResults.set("session/new", { sessionId: "grok-ordinary-title" });
  const adapter = new GrokProviderAdapter({ hostId: "host_ordinary_title", transportFactory: () => transport });
  await adapter.createSession({ workingDirectory: "C:\\workspace", title: "Temporary client title" });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-ordinary-title", cwd: "C:\\workspace", title: "Native generated title" }],
    nextCursor: null,
  });

  const listed = await adapter.listSessions();

  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.title, "Native generated title");
  await adapter.dispose();
});

test("Grok publishes non-empty native title changes without waiting for a relist", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-live-title" });
  const adapter = new GrokProviderAdapter({ hostId: "host_live_title", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { if (event.type === "session.updated") events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace", title: "New task" });

  transport.push({
    method: "_x.ai/sessions/changed",
    params: { upserted: [{ sessionId: "grok-live-title", title: "  Harness generated title  " }], removed: [] },
  });
  transport.push({
    method: "_x.ai/sessions/changed",
    params: { upserted: [{ sessionId: "grok-live-title", title: "   " }], removed: [] },
  });
  await delay(20);

  assert.deepEqual(events.filter((event) => event.payload.title !== undefined).map((event) => event.payload.title), [
    "Harness generated title",
  ]);
  await adapter.dispose();
});

test("Grok scheduled send ignores unrelated echoes, accepts its prompt, and retry does not resend", async () => {
  const request = {
    requestId: "schedule_grok_exactly_once",
    content: "Run the scheduled Grok task\nwith normalized lines",
    metadata: { tethoqScheduledTaskId: "schedule_grok_exactly_once" },
  } as const;

  const firstTransport = new FakeTransport();
  firstTransport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  firstTransport.methodResults.set("session/new", { sessionId: "grok-scheduled" });
  firstTransport.methodResults.set("session/load", {});
  firstTransport.blockedMethods.add("session/prompt");
  const firstAdapter = new GrokProviderAdapter({
    hostId: "host_schedule_first",
    requestTimeoutMs: 1_000,
    transportFactory: () => firstTransport,
  });
  await firstAdapter.createSession({ workingDirectory: "C:\\workspace" });
  const firstSend = firstAdapter.sendMessage("grok-scheduled", request);
  while (!firstTransport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/prompt")) {
    await delay(1);
  }
  let firstSendSettled = false;
  void firstSend.then(
    () => { firstSendSettled = true; },
    () => { firstSendSettled = true; },
  );
  firstTransport.push({
    method: "session/update",
    params: {
      sessionId: "grok-scheduled",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "An unrelated interactive prompt" },
        _meta: { promptIndex: 99 },
      },
    },
  });
  await delay(5);
  assert.equal(firstSendSettled, false, "an unrelated user echo must not accept the scheduled prompt");
  firstTransport.push({
    method: "session/update",
    params: {
      sessionId: "grok-scheduled",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "  Run the scheduled Grok task\r\nwith normalized lines \r\n" },
        _meta: { promptIndex: 0 },
      },
    },
  });
  assert.deepEqual(await firstSend, {
    accepted: true,
    providerTurnId: request.requestId,
    details: ["ACP session/prompt was accepted."],
  });
  await firstAdapter.dispose();

  const retryTransport = new FakeTransport();
  retryTransport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  retryTransport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-scheduled", cwd: "C:\\workspace" }],
    nextCursor: null,
  });
  retryTransport.notificationsBeforeResult.set("session/load", [{
    method: "session/update",
    params: {
      sessionId: "grok-scheduled",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: request.content },
        _meta: { promptIndex: 0 },
      },
    },
  }]);
  const retryAdapter = new GrokProviderAdapter({ hostId: "host_schedule_retry", transportFactory: () => retryTransport });
  const retried = await retryAdapter.sendMessage("grok-scheduled", request);

  assert.deepEqual(retried, {
    accepted: true,
    providerTurnId: request.requestId,
    details: ["Grok Build already accepted this scheduled prompt."],
  });
  assert.equal(retryTransport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/prompt"), false);
  await retryAdapter.dispose();
});

test("Grok scheduled retry ignores unrelated historical user prompts", async () => {
  const request = {
    requestId: "schedule_grok_after_history",
    content: "Run this new scheduled Grok task",
    metadata: { tethoqScheduledTaskId: "schedule_grok_after_history" },
  } as const;
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-scheduled-history", cwd: "C:\\workspace" }],
    nextCursor: null,
  });
  transport.notificationsBeforeResult.set("session/load", [{
    method: "session/update",
    params: {
      sessionId: "grok-scheduled-history",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "An older unrelated prompt" },
        _meta: { promptIndex: 0 },
      },
    },
  }]);
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = new GrokProviderAdapter({ hostId: "host_schedule_unrelated_history", transportFactory: () => transport });

  const result = await adapter.sendMessage("grok-scheduled-history", request);

  assert.equal(result.accepted, true);
  const prompts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/prompt");
  assert.equal(prompts.length, 1);
  await adapter.dispose();
});

test("Grok scheduled send rejects a remote prompt failure before any user echo", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  transport.methodResults.set("session/new", { sessionId: "grok-scheduled-rejected" });
  transport.methodResults.set("session/load", {});
  transport.blockedMethods.add("session/prompt");
  const adapter = new GrokProviderAdapter({
    hostId: "host_schedule_rejected",
    requestTimeoutMs: 10,
    transportFactory: () => transport,
  });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const send = adapter.sendMessage("grok-scheduled-rejected", {
    requestId: "schedule_grok_rejected",
    content: "This prompt is rejected",
    metadata: { tethoqScheduledTaskId: "schedule_grok_rejected" },
  });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({
    id: prompt.id,
    error: { code: -32000, message: "Grok rejected the scheduled prompt" },
  });
  await assert.rejects(send, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Grok rejected the scheduled prompt");
    return true;
  });
  await adapter.dispose();
});

test("Grok scheduled send remains bounded when neither an echo nor a final result arrives", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  transport.methodResults.set("session/new", { sessionId: "grok-scheduled-no-acceptance" });
  transport.methodResults.set("session/load", {});
  transport.blockedMethods.add("session/prompt");
  const adapter = new GrokProviderAdapter({
    hostId: "host_schedule_no_acceptance",
    requestTimeoutMs: 10,
    transportFactory: () => transport,
  });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await assert.rejects(
    adapter.sendMessage("grok-scheduled-no-acceptance", {
      requestId: "schedule_grok_no_acceptance",
      content: "Never echoed",
      metadata: { tethoqScheduledTaskId: "schedule_grok_no_acceptance" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAdapterError);
      assert.equal(error.code, "SCHEDULED_PROMPT_OUTCOME_UNCERTAIN");
      assert.equal(error.retryable, false);
      assert.match(error.message, /outcome is uncertain/u);
      return true;
    },
  );
  await adapter.dispose();
});

test("Grok keeps an accepted scheduled prompt alive beyond the ordinary request timeout", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  transport.methodResults.set("session/new", { sessionId: "grok-scheduled-long" });
  transport.methodResults.set("session/load", {});
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({
    hostId: "host_schedule_long",
    requestTimeoutMs: 10,
    transportFactory: () => transport,
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const send = adapter.sendMessage("grok-scheduled-long", {
    requestId: "schedule_grok_long",
    content: "Take longer than the transport timeout",
    metadata: { tethoqScheduledTaskId: "schedule_grok_long" },
  });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-scheduled-long",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Take longer than the transport timeout" } },
    },
  });
  assert.equal((await send).accepted, true);
  await delay(30);
  assert.equal(events.some((event) => event.type === "agent.error"), false);
  assert.equal(adapter.hasActiveTurn("grok-scheduled-long"), true);

  transport.push({ id: prompt.id, result: { stopReason: "end_turn" } });
  await delay();
  assert.equal(events.some((event) => event.type === "agent.completed"), true);
  assert.equal(adapter.hasActiveTurn("grok-scheduled-long"), false);
  await adapter.dispose();
});

test("Grok keeps an interactive prompt alive beyond the generic RPC timeout", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-long-interactive" });
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({
    hostId: "host_long_interactive",
    requestTimeoutMs: 10,
    transportFactory: () => transport,
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.sendMessage("grok-long-interactive", { requestId: "long-interactive", content: "Keep working" });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  await delay(30);
  assert.equal(events.some((event) => event.type === "agent.error"), false);
  assert.equal(adapter.hasActiveTurn("grok-long-interactive"), true);

  transport.push({ id: prompt.id, result: { stopReason: "end_turn" } });
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-long-interactive"), false);
  await adapter.dispose();
});

test("Grok ignores a cancelled prompt's late RPC result and keeps its successor healthy", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-cancelled-late-result" });
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({
    hostId: "host_cancelled_late_result",
    requestTimeoutMs: 10,
    transportFactory: () => transport,
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.sendMessage("grok-cancelled-late-result", { requestId: "cancelled", content: "Wait" });
  const firstPrompt = await waitForSentMethod(transport, "session/prompt");
  const stopping = adapter.interrupt("grok-cancelled-late-result");
  await waitForSentMethod(transport, "session/cancel");
  assert.equal(adapter.hasActiveTurn("grok-cancelled-late-result"), true);
  assert.equal(events.some((event) => event.type === "agent.interrupted"), false);
  transport.push({ id: firstPrompt.id, result: { stopReason: "cancelled" } });
  await stopping;
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.interrupted").length, 1);
  assert.equal(events.some((event) => event.type === "agent.completed" || event.type === "agent.error"), false);

  await adapter.sendMessage("grok-cancelled-late-result", { requestId: "successor", content: "Reply READY" });
  const prompts = transport.sent.filter((message): message is Record<string, unknown> =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/prompt");
  const successorPrompt = prompts.at(-1);
  assert.ok(successorPrompt);
  transport.push({ id: successorPrompt.id, result: { stopReason: "end_turn" } });
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "agent.error").length, 0);
  assert.equal(adapter.hasActiveTurn("grok-cancelled-late-result"), false);
  await adapter.dispose();
});

test("Grok Stop waits for a native turn acknowledgement without a local prompt RPC", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "stop-native", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({ method: "_x.ai/queue/changed", params: { sessionId: "native-session", entries: [], runningPromptId: "native-turn" } });
  await delay();
  let settled = false;
  const stopping = adapter.interrupt("native-session").then(() => { settled = true; });
  await waitForSentMethod(transport, "session/cancel");
  await delay();
  assert.equal(settled, false);
  assert.equal(adapter.hasActiveTurn("native-session"), true);
  assert.equal(events.some((event) => event.type === "agent.interrupted"), false);
  transport.push({ method: "session/update", params: { sessionId: "native-session", update: { sessionUpdate: "turn_completed", promptId: "native-turn", stopReason: "cancelled" } } });
  await stopping;
  assert.equal(adapter.hasActiveTurn("native-session"), false);
  assert.equal(events.filter((event) => event.type === "agent.interrupted").length, 1);
});

test("Grok Stop does not treat a failed prompt RPC as cancellation confirmation", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-stop-error" });
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "stop-error", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("grok-stop-error", { requestId: "send", content: "Work" });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  const stopping = assert.rejects(adapter.interrupt("grok-stop-error"), /connection lost/);
  await waitForSentMethod(transport, "session/cancel");
  transport.push({ id: prompt.id, error: { code: -32000, message: "connection lost" } });
  await stopping;
  assert.equal(events.some((event) => event.type === "agent.interrupted"), false);
  assert.equal(adapter.hasActiveTurn("grok-stop-error"), true);
});

test("Grok Stop does not report success before an unresponsive prompt confirms cancellation", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-stop-unconfirmed" });
  transport.blockedMethods.add("session/prompt");
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "stop-unconfirmed", requestTimeoutMs: 20, transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  await adapter.sendMessage("grok-stop-unconfirmed", { requestId: "send", content: "Keep working" });
  await assert.rejects(adapter.interrupt("grok-stop-unconfirmed"), /has not confirmed/);
  assert.equal(adapter.hasActiveTurn("grok-stop-unconfirmed"), true);
  assert.equal(events.some((event) => event.type === "agent.interrupted"), false);
});

test("Grok scheduled send fails closed when native history cannot be verified", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  transport.methodResults.set("session/new", { sessionId: "grok-scheduled-failure" });
  const adapter = new GrokProviderAdapter({ hostId: "host_schedule_history_failure", transportFactory: () => transport });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  transport.rejectedMethods.set("session/load", new Error("Scheduled Grok history unavailable"));

  await assert.rejects(
    adapter.sendMessage("grok-scheduled-failure", {
      requestId: "schedule_grok_history_failure",
      content: "Do not duplicate this scheduled task",
      metadata: { tethoqScheduledTaskId: "schedule_grok_history_failure" },
    }),
    /Scheduled Grok history unavailable/u,
  );
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/prompt"), false);
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

test("Grok Stop removes native follow-ups before cancellation so they cannot restart the task", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "stop-queue", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, () => undefined);
  transport.push({ method: "_x.ai/queue/changed", params: { sessionId: "queued-session", entries: [{ id: "follow-up", kind: "prompt", text: "Resume working" }] } });
  await delay();
  await adapter.interrupt("queued-session");
  const methods = transport.sent.flatMap((entry) => typeof entry === "object" && entry !== null && "method" in entry ? [entry.method] : []);
  assert.ok(methods.indexOf("_x.ai/queue/remove") >= 0);
  assert.ok(methods.indexOf("_x.ai/queue/remove") < methods.indexOf("session/cancel"));
  assert.deepEqual(await adapter.listQueuedMessages?.(), []);
  assert.equal(adapter.hasActiveTurn("queued-session"), false);
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

test("Grok queue display stays public while queued Steer applies fresh developer guidance exactly once", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-guided-queue" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const originalNativeText = [
    "<tethoq_response_guidance>",
    "Use the original private guidance.",
    "</tethoq_response_guidance>",
    "",
    "Keep working",
  ].join("\n");
  transport.notificationsBeforeResult.set("session/prompt", [{
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-guided-queue",
      entries: [{ id: "guided-q1", version: 4, kind: "prompt", text: originalNativeText }],
    },
  }]);
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "host_guided_queue", transportFactory: () => transport });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  const queued = await adapter.enqueueQueuedMessage?.("grok-guided-queue", {
    requestId: "request-guided-queue",
    content: "Keep working",
    developerInstructions: "Use the original private guidance.",
    workingDirectory: "C:\\workspace",
  });
  assert.equal(queued?.content, "Keep working");
  assert.equal(queued?.developerInstructions, "Use the original private guidance.");
  assert.deepEqual((await adapter.listQueuedMessages?.())?.map(({ id, content }) => ({ id, content })), [{
    id: "guided-q1",
    content: "Keep working",
  }]);
  assert.doesNotMatch(JSON.stringify(await adapter.listQueuedMessages?.()), /tethoq_response_guidance/u);

  const promptRequest = transport.sent.find((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/prompt") as Record<string, unknown>;
  const promptParts = ((promptRequest.params as Record<string, unknown>).prompt as { type: string; text: string }[]);
  assert.equal(promptParts[0]?.text, originalNativeText);
  assert.equal(promptParts[0]?.text.match(/<tethoq_response_guidance>/gu)?.length, 1);

  assert.ok(adapter.steerQueuedMessage);
  const steering = adapter.steerQueuedMessage("grok-guided-queue", "guided-q1", {
    requestId: "request-guided-steer",
    content: "Keep working",
    developerInstructions: "Use the fresh global guidance.",
  });
  const interject = await waitForSentMethod(transport, "_x.ai/queue/interject");
  const interjectParams = interject.params as Record<string, unknown>;
  assert.equal(interjectParams.id, "guided-q1");
  assert.equal(typeof interjectParams.newText, "string");
  assert.equal((interjectParams.newText as string).match(/<tethoq_response_guidance>/gu)?.length, 1);
  assert.match(interjectParams.newText as string, /Use the fresh global guidance/u);
  assert.doesNotMatch(interjectParams.newText as string, /Use the original private guidance/u);
  assert.equal((interjectParams.newText as string).endsWith("\n\nKeep working"), true);

  transport.push({
    method: "x.ai/session/interjection",
    params: {
      sessionId: "grok-guided-queue",
      text: interjectParams.newText,
      interjectionId: "guided-q1",
    },
  });
  transport.push({
    method: "x.ai/queue/changed",
    params: { sessionId: "grok-guided-queue", runningPromptId: "running-prompt", entries: [] },
  });
  assert.equal((await steering).accepted, true);
  await delay();
  const echoed = events.find((event) => event.type === "message.started"
    && event.providerSessionId === "grok-guided-queue"
    && event.payload.messageId === "guided-q1");
  assert.equal(echoed?.payload.text, "Keep working");
  assert.doesNotMatch(JSON.stringify(echoed), /tethoq_response_guidance/u);
  await adapter.dispose();
});

test("Grok identical queue sends correlate only newly observed native rows in order", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-identical-queue" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  const adapter = new GrokProviderAdapter({ hostId: "host_identical_queue", transportFactory: () => transport });
  await adapter.subscribe(null, () => undefined);
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-identical-queue",
      entries: [{ id: "older-identical", version: 1, kind: "prompt", text: "Same instruction" }],
    },
  });
  await delay();

  assert.ok(adapter.enqueueQueuedMessage);
  const first = adapter.enqueueQueuedMessage("grok-identical-queue", {
    requestId: "request-identical-one",
    content: "Same instruction",
    workingDirectory: "C:\\workspace",
  });
  const second = adapter.enqueueQueuedMessage("grok-identical-queue", {
    requestId: "request-identical-two",
    content: "Same instruction",
    workingDirectory: "C:\\workspace",
  });
  await waitForSentMethodCount(transport, "session/prompt", 2);
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-identical-queue",
      entries: [
        { id: "older-identical", version: 1, kind: "prompt", text: "Same instruction" },
        { id: "new-identical-one", version: 2, kind: "prompt", text: "Same instruction" },
      ],
    },
  });
  assert.equal((await first).id, "new-identical-one");
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-identical-queue",
      entries: [
        { id: "older-identical", version: 1, kind: "prompt", text: "Same instruction" },
        { id: "new-identical-one", version: 2, kind: "prompt", text: "Same instruction" },
        { id: "new-identical-two", version: 3, kind: "prompt", text: "Same instruction" },
      ],
    },
  });
  assert.equal((await second).id, "new-identical-two");

  assert.ok(adapter.steerQueuedMessage);
  const steering = adapter.steerQueuedMessage("grok-identical-queue", "new-identical-two", {
    requestId: "request-steer-identical-two",
    content: "Same instruction",
  });
  const interject = await waitForSentMethod(transport, "_x.ai/queue/interject");
  assert.deepEqual(interject.params, {
    sessionId: "grok-identical-queue",
    id: "new-identical-two",
    expectedVersion: 3,
  });
  transport.push({
    method: "x.ai/session/interjection",
    params: {
      sessionId: "grok-identical-queue",
      text: "Same instruction",
      interjectionId: "new-identical-two",
    },
  });
  assert.equal((await steering).accepted, true);
  await adapter.dispose();
});

test("Grok enqueue rejects when session/prompt was never sent instead of fabricating a queued row", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-session" });
  transport.rejectedMethods.set("session/prompt", new Error("ACP prompt transport rejected"));
  const adapter = new GrokProviderAdapter({ hostId: "host_1", transportFactory: () => transport });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  assert.ok(adapter.enqueueQueuedMessage);
  await assert.rejects(adapter.enqueueQueuedMessage("grok-session", {
    requestId: "request-queue-failed",
    content: "This must not look queued",
    workingDirectory: "C:\\workspace",
  }), /ACP prompt transport rejected/u);
  assert.deepEqual(await adapter.listQueuedMessages?.(), []);
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

test("Grok queued Steer uses the versioned native interjection and waits for authoritative confirmation", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const events: ProviderEvent[] = [];
  const adapter = new GrokProviderAdapter({ hostId: "host_queue_steer", transportFactory: () => transport });
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-session",
      runningPromptId: "running-prompt",
      entries: [{ id: "native-q4", version: 6, kind: "prompt", text: "Change direction" }],
    },
  });
  await delay();

  assert.ok(adapter.steerQueuedMessage);
  const delivery = adapter.steerQueuedMessage("grok-session", "native-q4", {
    requestId: "request-queue-steer",
    content: "Change direction",
  });
  const interject = await waitForSentMethod(transport, "_x.ai/queue/interject");
  assert.deepEqual(interject.params, {
    sessionId: "grok-session",
    id: "native-q4",
    expectedVersion: 6,
  });

  transport.push({
    method: "x.ai/session/interjection",
    params: {
      sessionId: "grok-session",
      text: "Change direction",
      interjectionId: "native-q4",
    },
  });
  transport.push({
    method: "x.ai/queue/changed",
    params: { sessionId: "grok-session", runningPromptId: "running-prompt", entries: [] },
  });
  const result = await delivery;
  await delay();

  assert.equal(result.accepted, true);
  assert.deepEqual(await adapter.listQueuedMessages?.(), []);
  assert.ok(events.some((event) => event.type === "message.started"
    && event.providerSessionId === "grok-session"
    && event.payload.messageId === "native-q4"
    && event.payload.text === "Change direction"));
  const methods = transport.sent.flatMap((message) => (
    typeof message === "object" && message !== null && typeof (message as Record<string, unknown>).method === "string"
      ? [(message as Record<string, unknown>).method as string]
      : []
  ));
  assert.equal(methods.includes("session/cancel"), false);
  assert.equal(methods.includes("session/prompt"), false);
  await adapter.dispose();
});

test("Grok queued Steer keeps an unconfirmed instruction retryable", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({
    hostId: "host_queue_steer_noop",
    requestTimeoutMs: 20,
    transportFactory: () => transport,
  });
  await adapter.subscribe(null, () => undefined);
  const unchanged = {
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-session",
      runningPromptId: "running-prompt",
      entries: [{ id: "native-q5", version: 8, kind: "prompt", text: "Do not lose this" }],
    },
  };
  transport.push(unchanged);
  await delay();

  assert.ok(adapter.steerQueuedMessage);
  const delivery = adapter.steerQueuedMessage("grok-session", "native-q5", {
    requestId: "request-queue-steer-noop",
    content: "Do not lose this",
  });
  await waitForSentMethod(transport, "_x.ai/queue/interject");
  transport.push(unchanged);
  await assert.rejects(delivery, /remains available to retry/u);
  assert.deepEqual((await adapter.listQueuedMessages?.())?.map(({ id, content }) => ({ id, content })), [{
    id: "native-q5",
    content: "Do not lose this",
  }]);
  await adapter.dispose();
});

test("Grok ordinary Steer durably queues then atomically interjects on the installed ACP surface", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-steer-session" });
  transport.methodResults.set("session/prompt", { stopReason: "end_turn" });
  transport.notificationsBeforeResult.set("session/prompt", [{
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-steer-session",
      runningPromptId: "running-prompt",
      entries: [{ id: "direct-steer-row", version: 3, kind: "prompt", text: "Use the smaller fix" }],
    },
  }]);
  const adapter = new GrokProviderAdapter({ hostId: "host_direct_steer", transportFactory: () => transport });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  assert.equal((await adapter.getCapabilities()).steering, true);
  assert.ok(adapter.steerMessage);
  const steering = adapter.steerMessage("grok-steer-session", {
    requestId: "request-direct-steer",
    content: "Use the smaller fix",
  });
  const interject = await waitForSentMethod(transport, "_x.ai/queue/interject");
  assert.deepEqual(interject.params, {
    sessionId: "grok-steer-session",
    id: "direct-steer-row",
    expectedVersion: 3,
  });
  transport.push({
    method: "x.ai/session/interjection",
    params: {
      sessionId: "grok-steer-session",
      text: "Use the smaller fix",
      interjectionId: "direct-steer-row",
    },
  });
  transport.push({
    method: "x.ai/queue/changed",
    params: { sessionId: "grok-steer-session", runningPromptId: "running-prompt", entries: [] },
  });
  const result = await steering;
  assert.equal(result.accepted, true);
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "x.ai/interject"), false);
  await adapter.dispose();
});

test("Grok queued Steer completes after the final owned prompt settles even when its running ID is stale", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-steer-terminal" });
  const adapter = new GrokProviderAdapter({ hostId: "host_steer_terminal", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  transport.blockedMethods.add("session/prompt");

  await adapter.sendMessage("grok-steer-terminal", { requestId: "initial-prompt", content: "Start" });
  assert.ok(adapter.enqueueQueuedMessage);
  const queuedDelivery = adapter.enqueueQueuedMessage("grok-steer-terminal", {
    requestId: "queued-prompt",
    content: "Use the browser inventory",
    workingDirectory: "C:\\workspace",
  });
  await waitForSentMethodCount(transport, "session/prompt", 2);
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-steer-terminal",
      runningPromptId: "initial-native-prompt",
      entries: [{ id: "queued-native-prompt", version: 2, kind: "prompt", text: "Use the browser inventory" }],
    },
  });
  const queued = await queuedDelivery;

  assert.ok(adapter.steerQueuedMessage);
  const steering = adapter.steerQueuedMessage("grok-steer-terminal", queued.id, {
    requestId: "steer-prompt",
    content: "Use the browser inventory",
  });
  await waitForSentMethod(transport, "_x.ai/queue/interject");
  transport.push({
    method: "x.ai/session/interjection",
    params: {
      sessionId: "grok-steer-terminal",
      text: "Use the browser inventory",
      interjectionId: queued.id,
    },
  });
  transport.push({
    method: "x.ai/queue/changed",
    params: { sessionId: "grok-steer-terminal", runningPromptId: "queued-native-prompt", entries: [] },
  });
  await steering;
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-steer-terminal",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
    },
  });

  const prompts = transport.sent.filter((message): message is Record<string, unknown> =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/prompt");
  assert.equal(prompts.length, 2);
  transport.push({ id: prompts[0]?.id, result: { stopReason: "end_turn" } });
  await delay();
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  transport.push({ id: prompts[1]?.id, result: { stopReason: "end_turn" } });
  await delay(20);

  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-steer-terminal"), false);
  await adapter.dispose();
});

test("Grok defers an owned terminal while a real native queue entry remains", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-real-queue" });
  const adapter = new GrokProviderAdapter({ hostId: "host_real_queue", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  transport.blockedMethods.add("session/prompt");

  await adapter.sendMessage("grok-real-queue", { requestId: "owned-prompt", content: "Start" });
  transport.push({
    method: "x.ai/queue/changed",
    params: {
      sessionId: "grok-real-queue",
      runningPromptId: "owned-native-prompt",
      entries: [{ id: "real-queued-prompt", version: 1, kind: "prompt", text: "Still queued" }],
    },
  });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({ id: prompt.id, result: { stopReason: "end_turn" } });
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);

  transport.push({
    method: "x.ai/queue/changed",
    params: { sessionId: "grok-real-queue", runningPromptId: "real-queued-prompt", entries: [] },
  });
  await delay();
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  assert.equal(adapter.hasActiveTurn("grok-real-queue"), true);

  transport.push({ method: "x.ai/queue/changed", params: { sessionId: "grok-real-queue", entries: [] } });
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-real-queue"), false);
  await adapter.dispose();
});

test("Grok keeps an interim answer active while its ACP tool runs and settles on the later genuine prompt", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-running-tool" });
  transport.blockedMethods.add("session/prompt");
  const adapter = new GrokProviderAdapter({ hostId: "host_running_tool", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.sendMessage("grok-running-tool", { requestId: "prompt-before-tool", content: "Run the command" });
  const firstPrompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-running-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "sleep-call",
        command: "PowerShell Start-Sleep -Seconds 300",
      },
    },
  });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-running-tool",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The sleep is still running; I'll wait for it to finish before answering." },
      },
    },
  });
  transport.push({ id: firstPrompt.id, result: { stopReason: "end_turn" } });
  await delay(20);

  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  assert.equal(adapter.hasActiveTurn("grok-running-tool"), true);

  await adapter.sendMessage("grok-running-tool", { requestId: "later-genuine-prompt", content: "Reply when ready" });
  await waitForSentMethodCount(transport, "session/prompt", 2);
  const prompts = transport.sent.filter((message): message is Record<string, unknown> =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "session/prompt");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-running-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "sleep-call",
        status: "completed",
        command: "PowerShell Start-Sleep -Seconds 300",
      },
    },
  });
  await delay(20);

  assert.equal(events.filter((event) => event.type === "command.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  assert.equal(adapter.hasActiveTurn("grok-running-tool"), true);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-running-tool",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "READY" } },
    },
  });
  transport.push({ id: prompts[1]?.id, result: { stopReason: "end_turn" } });
  await delay(20);

  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-running-tool"), false);
  await adapter.dispose();
});

test("Grok interrupt clears unresolved tool ownership without reviving its deferred terminal", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-interrupted-tool" });
  transport.blockedMethods.add("session/prompt");
  const adapter = new GrokProviderAdapter({ hostId: "host_interrupted_tool", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.sendMessage("grok-interrupted-tool", { requestId: "interrupted-prompt", content: "Run the command" });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-interrupted-tool",
      update: { sessionUpdate: "tool_call", toolCallId: "interrupted-call", command: "PowerShell Start-Sleep -Seconds 300" },
    },
  });
  transport.push({ id: prompt.id, result: { stopReason: "end_turn" } });
  await delay(20);
  assert.equal(adapter.hasActiveTurn("grok-interrupted-tool"), true);

  const stopping = adapter.interrupt("grok-interrupted-tool");
  await waitForSentMethod(transport, "session/cancel");
  assert.equal(events.some((event) => event.type === "agent.interrupted"), false);
  transport.push({ method: "session/update", params: { sessionId: "grok-interrupted-tool", update: { sessionUpdate: "turn_completed", stopReason: "cancelled" } } });
  await stopping;
  assert.equal(adapter.hasActiveTurn("grok-interrupted-tool"), false);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  assert.equal(events.filter((event) => event.type === "agent.interrupted").length, 1);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-interrupted-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "interrupted-call",
        status: "completed",
        command: "PowerShell Start-Sleep -Seconds 300",
      },
    },
  });
  await delay(20);
  assert.equal(adapter.hasActiveTurn("grok-interrupted-tool"), false);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  await adapter.dispose();
});

test("Grok turn_completed retires an orphaned tool call when cancellation omits its terminal update", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_orphaned_tool", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-orphaned-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "orphaned-call",
        command: "PowerShell Start-Sleep -Seconds 120",
      },
      _meta: { promptId: "cancelled-prompt" },
    },
  });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-orphaned-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "orphaned-call",
        status: "running",
      },
      _meta: { promptId: "cancelled-prompt" },
    },
  });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-orphaned-tool",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The command is still running." },
      },
      _meta: { promptId: "cancelled-prompt" },
    },
  });
  await delay(20);
  assert.equal(adapter.hasActiveTurn("grok-orphaned-tool"), true);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-orphaned-tool",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "cancelled-prompt",
        stop_reason: "cancelled",
      },
    },
  });
  await delay(20);

  assert.equal(adapter.hasActiveTurn("grok-orphaned-tool"), false);
  assert.equal(events.filter((event) => event.type === "agent.interrupted").length, 1);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  await adapter.dispose();
});

test("Grok provider-initiated background wake completes from turn_completed exactly once", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_background_wake", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-background-wake",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "The background command completed." },
      },
      _meta: { promptId: "background-prompt" },
    },
  });
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-background-wake",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "READY" },
      },
      _meta: { promptId: "background-prompt" },
    },
  });
  const completedUpdate = {
    method: "session/update",
    params: {
      sessionId: "grok-background-wake",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "background-prompt",
        stop_reason: "end_turn",
      },
    },
  };
  transport.push(completedUpdate);
  await delay(20);

  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-background-wake"), false);

  transport.push(completedUpdate);
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  await adapter.dispose();
});

test("Grok owned prompt turn_completed waits for its RPC result without duplicating completion", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  transport.methodResults.set("session/new", { sessionId: "grok-owned-terminal" });
  transport.blockedMethods.add("session/prompt");
  const adapter = new GrokProviderAdapter({ hostId: "host_owned_terminal", transportFactory: () => transport });
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });

  await adapter.sendMessage("grok-owned-terminal", { requestId: "owned-prompt", content: "Reply READY" });
  const prompt = await waitForSentMethod(transport, "session/prompt");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-owned-terminal",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "READY" },
      },
      _meta: { promptId: "owned-native-prompt" },
    },
  });
  const completedUpdate = {
    method: "session/update",
    params: {
      sessionId: "grok-owned-terminal",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "owned-native-prompt",
        stop_reason: "end_turn",
      },
    },
  };
  transport.push(completedUpdate);
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 0);
  assert.equal(adapter.hasActiveTurn("grok-owned-terminal"), true);

  transport.push({ id: prompt.id, result: { stopReason: "end_turn" } });
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(adapter.hasActiveTurn("grok-owned-terminal"), false);

  transport.push(completedUpdate);
  await delay(20);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  await adapter.dispose();
});

test("Grok turn_completed preserves active tools owned by a newer prompt", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = new GrokProviderAdapter({ hostId: "host_prompt_scoped_tools", transportFactory: () => transport });
  await adapter.subscribe(null, () => undefined);

  for (const [toolCallId, promptId] of [["older-call", "older-prompt"], ["newer-call", "newer-prompt"]] as const) {
    transport.push({
      method: "session/update",
      params: {
        sessionId: "grok-prompt-scoped-tools",
        update: { sessionUpdate: "tool_call", toolCallId, title: "get_command_or_subagent_output" },
        _meta: { promptId },
      },
    });
  }
  await delay(20);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-prompt-scoped-tools",
      update: { sessionUpdate: "turn_completed", prompt_id: "older-prompt", stop_reason: "cancelled" },
    },
  });
  await delay(20);
  assert.equal(adapter.hasActiveTurn("grok-prompt-scoped-tools"), true);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-prompt-scoped-tools",
      update: { sessionUpdate: "tool_call_update", toolCallId: "newer-call", status: "completed" },
      _meta: { promptId: "newer-prompt" },
    },
  });
  await delay(20);
  assert.equal(adapter.hasActiveTurn("grok-prompt-scoped-tools"), false);
  await adapter.dispose();
});

test("public ACP adapters do not claim Grok's native queue", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", { protocolVersion: 1, agentCapabilities: {} });
  const adapter = createPublicAcpProviderAdapter("qwen", { hostId: "host_1", transportFactory: () => transport });
  assert.equal(adapter.enqueueQueuedMessage, undefined);
  assert.equal(adapter.listQueuedMessages, undefined);
  assert.equal(adapter.steerQueuedMessage, undefined);
  assert.equal(adapter.steerMessage, undefined);
  assert.equal((await adapter.getCapabilities()).steering, false);
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
  let bindingLifecycleOwner: unknown;
  adapter.configureClientTooling({
    definitions: [{ name: "browser_inspect", description: "Inspect the browser", inputSchema: { type: "object" } }],
    async execute() { return {}; },
    mcpServer() { return { name: "mesh", command: "node", args: ["mesh.js"], env: { BOUND: "1" } }; },
    createSessionBinding(_providerId, lifecycleOwner) {
      bindingLifecycleOwner = lifecycleOwner;
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
  assert.equal(bindingLifecycleOwner, "provider");

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

test("Grok context keeps the session model capacity across sparse and conflicting usage updates", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: true, resume: true } },
  });
  transport.methodResults.set("session/list", {
    sessions: [
      { sessionId: "grok-context-a", cwd: "C:\\workspace" },
      { sessionId: "grok-context-b", cwd: "C:\\workspace" },
    ],
    nextCursor: null,
  });
  transport.methodResults.set("session/load", {
    models: {
      currentModelId: "grok-4.6",
      availableModels: [{ modelId: "grok-4.6", _meta: { totalContextTokens: 500_000 } }],
    },
  });
  transport.notificationsBeforeResult.set("session/load", [
    {
      method: "session/update",
      params: {
        sessionId: "grok-context-a",
        _meta: { totalTokens: 15_600 },
        update: { sessionUpdate: "session_info_update", usage: { totalTokens: 15_600 } },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-context-a",
        _meta: { totalTokens: 253_679 },
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    },
  ]);
  const adapter = new GrokProviderAdapter({ hostId: "host_grok_context", transportFactory: () => transport });

  const loaded = await adapter.getSessionContext("grok-context-a");
  transport.notificationsBeforeResult.delete("session/load");
  assert.equal(loaded.modelId, "grok-4.6");
  assert.equal(loaded.usedTokens, 253_679, "the final replay metadata is the current occupancy");
  assert.equal(loaded.contextWindowTokens, 500_000);
  assert.equal(loaded.usage.totalTokens, 15_600, "historical request usage remains a usage detail, not occupancy");
  await adapter.getSessionContext("grok-context-a");
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "session/load").length, 1,
    "repeated context reads reuse the completed native hydration");

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-context-a",
      update: { sessionUpdate: "usage_update", used: 15_600, size: 254_000 },
    },
  });
  await delay();
  const fromUsage = await adapter.getSessionContext("grok-context-a");
  assert.equal(fromUsage.usedTokens, 15_600);
  assert.equal(fromUsage.contextWindowTokens, 500_000, "model metadata outranks a conflicting transient size");
  assert.ok(Math.abs((fromUsage.usedPercent ?? 0) - 3.12) < 0.000_001);

  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-context-a",
      update: { sessionUpdate: "model_changed", model_id: "grok-4.6", reasoning_effort: "xhigh" },
    },
  });
  await delay();
  const afterSparseModel = await adapter.getSessionContext("grok-context-a");
  assert.equal(afterSparseModel.contextWindowTokens, 500_000, "a same-model update must not erase the proven limit");

  transport.methodResults.set("session/resume", {
    models: {
      currentModelId: "grok-4.5",
      availableModels: [{ modelId: "grok-4.5", _meta: { totalContextTokens: 128_000 } }],
    },
  });
  await adapter.resumeSession("grok-context-a");
  const changedModel = await adapter.getSessionContext("grok-context-a");
  assert.equal(changedModel.modelId, "grok-4.5");
  assert.equal(changedModel.contextWindowTokens, 128_000, "a proven model change adopts its own capacity");

  transport.methodResults.set("session/load", {
    models: {
      currentModelId: "grok-context-b-model",
      availableModels: [{ modelId: "grok-context-b-model", _meta: { totalContextTokens: 64_000 } }],
    },
  });
  await adapter.getMessages("grok-context-b");
  transport.push({
    method: "session/update",
    params: {
      sessionId: "grok-context-b",
      update: { sessionUpdate: "usage_update", used: 2_000, size: 64_000 },
    },
  });
  await delay();
  const sessionA = await adapter.getSessionContext("grok-context-a");
  const sessionB = await adapter.getSessionContext("grok-context-b");
  assert.equal(sessionA.contextWindowTokens, 128_000);
  assert.equal(sessionA.usedTokens, 15_600);
  assert.equal(sessionB.contextWindowTokens, 64_000);
  assert.equal(sessionB.usedTokens, 2_000);
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

test("Grok session/load preserves assistant segments separated by tool calls", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-tool-history", cwd: "C:\\workspace", title: "Tool history" }],
    nextCursor: null,
  });
  transport.notificationsBeforeResult.set("session/load", [
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Run the tool, then reply exactly SCHEDULED_OK_GROK" },
          _meta: { promptIndex: 0 },
        },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Starting the requested tool." } },
        _meta: { promptId: "prompt-with-tool", streamStartMs: 1_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll run the requested tool now." } },
        _meta: { promptId: "prompt-with-tool", streamStartMs: 1_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command" },
        _meta: { promptId: "prompt-with-tool", streamStartMs: 1_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
        _meta: { promptId: "prompt-with-tool", streamStartMs: 1_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The tool finished." } },
        _meta: { prompt_id: "prompt-with-tool", stream_start_ms: 2_000 },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-tool-history",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SCHEDULED_OK_GROK" } },
        _meta: { prompt_id: "prompt-with-tool", stream_start_ms: 2_000 },
      },
    },
  ]);
  const adapter = new GrokProviderAdapter({ hostId: "host_tool_history", transportFactory: () => transport });

  const messages = await adapter.getMessages("grok-tool-history");
  const assistant = messages.filter((message) => message.role === "assistant");

  assert.deepEqual(assistant.map((message) => message.providerMessageId), [
    "assistant_prompt_prompt-with-tool_stream_1000",
    "assistant_prompt_prompt-with-tool_stream_2000",
  ]);
  assert.deepEqual(assistant.map((message) => message.parts), [
    [
      { type: "reasoning", text: "Starting the requested tool.", redacted: false },
      { type: "text", text: "I'll run the requested tool now." },
    ],
    [
      { type: "reasoning", text: "The tool finished.", redacted: false },
      { type: "text", text: "SCHEDULED_OK_GROK" },
    ],
  ]);
  const finalText = assistant.at(-1)?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  assert.equal(finalText, "SCHEDULED_OK_GROK");
  await adapter.dispose();
});

test("Grok session/load preserves provider event timestamps for replayed content", async () => {
  const transport = new FakeTransport();
  transport.methodResults.set("initialize", {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: true }, loadSession: true },
  });
  transport.methodResults.set("session/list", {
    sessions: [{ sessionId: "grok-timestamp-history", cwd: "C:\\workspace", title: "Timestamp history" }],
    nextCursor: null,
  });
  const userTimestamp = Date.parse("2026-08-29T16:58:03.722Z");
  const assistantTimestamp = Date.parse("2026-08-29T16:58:05.610Z");
  const replayTime = new Date("2026-08-29T16:58:49.079Z");
  transport.notificationsBeforeResult.set("session/load", [
    {
      method: "session/update",
      params: {
        sessionId: "grok-timestamp-history",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Run the scheduled task" },
          _meta: { promptIndex: 0 },
        },
        _meta: { agentTimestampMs: userTimestamp },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-timestamp-history",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "SCHEDULED_OK_GROK" },
          _meta: {
            prompt_id: "prompt-with-update-timestamp",
            agent_timestamp_ms: assistantTimestamp,
          },
        },
      },
    },
    {
      method: "session/update",
      params: {
        sessionId: "grok-timestamp-history",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Invalid provider timestamp" },
          _meta: { promptIndex: 1 },
        },
        _meta: { agentTimestampMs: Number.MAX_VALUE },
      },
    },
  ]);
  const adapter = new GrokProviderAdapter({
    hostId: "host_timestamp_history",
    now: () => replayTime,
    transportFactory: () => transport,
  });

  const messages = await adapter.getMessages("grok-timestamp-history");

  assert.deepEqual(messages.map((message) => message.createdAt), [
    "2026-08-29T16:58:03.722Z",
    "2026-08-29T16:58:05.610Z",
    replayTime.toISOString(),
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
