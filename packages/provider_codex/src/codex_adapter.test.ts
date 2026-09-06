import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, mergeCodexMessageHistory } from "./codex_adapter.js";
import { hiddenProviderControlContent } from "../../provider_contract/src/index.js";
import { codexTurnInput } from "./codex_input.js";
import type { JsonRpcTransport, ProviderClientTooling, ProviderEvent } from "../../provider_contract/src/index.js";

class FakeTransport implements JsonRpcTransport {
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();
  readonly closeListeners = new Set<(error: Error) => void>();
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
  public onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  public async close(): Promise<void> { this.closeCalls += 1; }
  public push(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }
  public crash(error: Error): void {
    for (const listener of [...this.closeListeners]) listener(error);
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

test("Codex Continue starts generation without user input and preserves a later typed continue", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("turn/start", { turn: { id: "resumed-turn" } });
  const adapter = new CodexAdapter({ hostId: "continue-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.sendMessage("thread", {
    requestId: "button", content: hiddenProviderControlContent("continue"),
    developerInstructions: "Resume the interrupted task.", modelId: "selected-model", reasoningEffort: "high",
  });
  await adapter.sendMessage("thread", { requestId: "typed", content: "continue" });
  const starts = transport.sent.filter((m): m is { method: string; params: unknown } =>
    typeof m === "object" && m !== null && "method" in m && m.method === "turn/start");
  assert.deepEqual(starts.map(m => m.params), [
    { threadId: "thread", clientUserMessageId: "button", input: [], model: "selected-model", effort: "high" },
    { threadId: "thread", clientUserMessageId: "typed", input: [{ type: "text", text: "continue", text_elements: [] }] },
  ]);
  const bootstrap = "Required task context\n" + hiddenProviderControlContent("continue");
  assert.deepEqual(codexTurnInput({ requestId: "bootstrap", content: bootstrap }), [{ type: "text", text: bootstrap, text_elements: [] }]);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Codex Stop recovers an untracked active turn and verifies that it ended", async (t) => {
  const transport = new FakeTransport();
  transport.methodResponses.set("thread/read", [
    { result: { thread: { id: "reconnected", status: { type: "active" }, turns: [{ id: "live-turn", status: "inProgress" }] } } },
    { result: { thread: { id: "reconnected", status: { type: "idle" }, turns: [{ id: "live-turn", status: "interrupted" }] } } },
  ]);
  const adapter = new CodexAdapter({ hostId: "stop-reconnected", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.interrupt("reconnected");
  const cancellation = transport.sent.find((value) => typeof value === "object" && value !== null && "method" in value && value.method === "turn/interrupt") as { params: unknown };
  assert.deepEqual(cancellation.params, { threadId: "reconnected", turnId: "live-turn" });
  assert.equal(adapter.hasActiveTurn("reconnected"), false);
});

test("Codex Stop accepts a verified idle task but does not mistake unknown activity for idle", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("thread/read", { thread: { id: "idle", status: { type: "idle" }, turns: [] } });
  const adapter = new CodexAdapter({ hostId: "stop-idle", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.interrupt("idle");
  transport.methodResults.set("thread/read", { thread: { id: "unknown", status: { type: "active" }, turns: [] } });
  await assert.rejects(adapter.interrupt("unknown"), /could not identify the active turn/);
  assert.equal(transport.sent.some((value) => typeof value === "object" && value !== null && "method" in value && value.method === "turn/interrupt"), false);
});

test("Codex Stop does not report success when cancellation is accepted but the turn keeps running", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("turn/start", { turn: { id: "still-live" } });
  transport.methodResults.set("thread/read", { thread: { id: "thread", status: { type: "active" }, turns: [{ id: "still-live", status: "inProgress" }] } });
  const adapter = new CodexAdapter({ hostId: "stop-unconfirmed", requestTimeoutMs: 20, transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.sendMessage("thread", { requestId: "send", content: "Work" });
  await assert.rejects(adapter.interrupt("thread"), /has not confirmed/);
  assert.equal(adapter.hasActiveTurn("thread"), true);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function writeDesktopResponse(socket: Socket, response: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(response), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

async function adapterWithPeer(options: { readonly isolatedVisionRuntime?: boolean } = {}): Promise<{ adapter: CodexAdapter; transport: FakeTransport; events: ProviderEvent[] }> {
  const transport = new FakeTransport();
  const events: ProviderEvent[] = [];
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, ...options });
  await adapter.subscribe(null, (event) => { events.push(event); });
  // force peer initialization through a benign request
  await adapter.getAuthStatus();
  return { adapter, transport, events };
}

for (const mode of ["form", "openai/form", "openaiForm"] as const) {
  test(`Codex ${mode} MCP elicitation returns typed native content and retains invalid submissions`, async (t) => {
    const { adapter, transport, events } = await adapterWithPeer();
    t.after(() => adapter.dispose());
    const requestId = `elicitation-${mode}`;
    transport.push({ id: requestId, method: "mcpServer/elicitation/request", params: {
      threadId: "form-task", turnId: "form-turn", serverName: "Workspace", mode, _meta: null,
      message: "Choose the validation settings",
      requestedSchema: { type: "object", properties: {
        name: { type: "string", title: "Name", minLength: 2 },
        count: { type: "integer", minimum: 1, maximum: 5 },
        enabled: { type: "boolean" },
        checks: { type: "array", items: { type: "string", enum: ["tests", "build"] } },
      }, required: ["name", "count", "enabled"] },
    } });
    await delay(10);
    const requested = events.find((event) => event.type === "user_input.requested");
    assert.equal(requested?.providerSessionId, "form-task");
    assert.equal((requested?.payload.request as Record<string, unknown>).kind, "elicitation");
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: requestId, answers: { action: "accept", content: { name: "QA" } } }), /required/);
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: requestId, answers: { action: "accept", content: { name: "QA", count: 1.5, enabled: true } } }), /invalid/);
    assert.equal(sentResult(transport, requestId), undefined);
    await adapter.respondToUserInput({ providerRequestId: requestId, answers: { action: "accept", content: { name: "QA", count: 3, enabled: false, checks: ["build", "tests"], extra: "omitted" } } });
    await delay(10);
    assert.deepEqual(JSON.parse(JSON.stringify(sentResult(transport, requestId))), {
      action: "accept", content: { name: "QA", count: 3, enabled: false, checks: ["build", "tests"] }, _meta: null,
    });
    await assert.rejects(adapter.respondToUserInput({ providerRequestId: requestId, answers: { action: "cancel" } }), /stale/);
  });
}

test("Codex URL elicitation returns native accept, decline, and cancel without fabricated content", async (t) => {
  const { adapter, transport } = await adapterWithPeer();
  t.after(() => adapter.dispose());
  for (const action of ["accept", "decline", "cancel"] as const) {
    const requestId = `url-${action}`;
    transport.push({ id: requestId, method: "mcpServer/elicitation/request", params: {
      threadId: "url-task", turnId: null, serverName: "Workspace", mode: "url", _meta: null,
      message: "Connect the service", url: "https://example.invalid/connect", elicitationId: "elicitation-native",
    } });
    await delay(10);
    await adapter.respondToUserInput({ providerRequestId: requestId, answers: { action } });
    await delay(10);
    assert.deepEqual(sentResult(transport, requestId), { action, content: null, _meta: null });
  }
});

test("Codex terminal events cancel only the completed task's turn-scoped elicitation", async (t) => {
  const { adapter, transport, events } = await adapterWithPeer();
  t.after(() => adapter.dispose());
  for (const taskId of ["stopped-task", "other-task"]) {
    transport.push({ method: "turn/started", params: { threadId: taskId, turn: { id: `${taskId}-turn` } } });
    transport.push({ id: `${taskId}-input`, method: "mcpServer/elicitation/request", params: {
      threadId: taskId, turnId: `${taskId}-turn`, serverName: "Workspace", mode: "form", _meta: null,
      message: "Enter a label", requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    } });
  }
  await delay(10);
  transport.push({ method: "turn/completed", params: { threadId: "stopped-task", turn: { id: "stopped-task-turn", status: "interrupted" } } });
  await delay(15);
  assert.deepEqual(sentResult(transport, "stopped-task-input"), { action: "cancel", content: null, _meta: null });
  assert.equal(sentResult(transport, "other-task-input"), undefined);
  assert.ok(events.some((event) => event.type === "user_input.resolved" && event.payload.providerRequestId === "stopped-task-input" && event.payload.reason === "cancelled"));
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "stopped-task-input", answers: { action: "accept", content: { label: "late" } } }), /stale/);
  await adapter.respondToUserInput({ providerRequestId: "other-task-input", answers: { action: "accept", content: { label: "still active" } } });
  await delay(10);
  assert.deepEqual(JSON.parse(JSON.stringify(sentResult(transport, "other-task-input"))), { action: "accept", content: { label: "still active" }, _meta: null });
});

test("Codex task permission overrides affect selected ordinary turns and preserve private helper isolation", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("thread/resume", { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
  transport.methodResults.set("configRequirements/read", { requirements: null });
  transport.methodResults.set("thread/start", { thread: { id: "no-client-tools", createdAt: 1, updatedAt: 1 } });
  transport.methodResults.set("turn/start", { turn: { id: "test-turn" } });
  const adapter = new CodexAdapter({ hostId: "permission-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.setSessionPermission("selected", "approvalPolicy", "never");
  await adapter.setSessionPermission("selected", "sandbox", "read-only");
  await adapter.createSession({ workingDirectory: "C:\\fixture", clientTools: "none" });
  await adapter.setSessionPermission("no-client-tools", "sandbox", "workspace-write");
  await adapter.sendMessage("selected", { requestId: "selected-user", content: "Inspect" });
  await adapter.sendMessage("other", { requestId: "ordinary-user", content: "Inspect" });
  await adapter.sendMessage("selected", { requestId: "helper-vision", content: "Inspect image", metadata: { internalPurpose: "vision_proxy" } });
  await adapter.sendMessage("selected", { requestId: "helper-ears", content: "Listen", metadata: { internalPurpose: "ears" } });
  await adapter.sendMessage("no-client-tools", { requestId: "without-client-tools", content: "Inspect" });
  const starts = transport.sent.filter((value): value is { method: string; params: Record<string, unknown> } =>
    typeof value === "object" && value !== null && "method" in value && value.method === "turn/start");
  assert.equal(starts.length, 5);
  assert.equal(starts[0]?.params.approvalPolicy, "never");
  assert.deepEqual(starts[0]?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  for (const index of [1, 2, 3]) {
    assert.equal("approvalPolicy" in starts[index]!.params, false);
    assert.equal("sandboxPolicy" in starts[index]!.params, false);
  }
  assert.deepEqual(starts[4]?.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(transport.sent.some((value) => typeof value === "object" && value !== null && "method" in value && /config.*write/iu.test(String(value.method))), false);
});

test("Codex checks changed native requirements before a selected task reaches turn/start", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("thread/resume", { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
  transport.methodResults.set("configRequirements/read", { requirements: null });
  const adapter = new CodexAdapter({ hostId: "restricted-permission-test", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.setSessionPermission("selected", "sandbox", "danger-full-access");
  transport.methodResults.set("configRequirements/read", { requirements: { allowedSandboxModes: ["read-only"] } });
  await assert.rejects(adapter.sendMessage("selected", { requestId: "blocked-by-requirements", content: "Inspect" }), /no longer allow/);
  assert.equal(transport.sent.some((value) => typeof value === "object" && value !== null && "method" in value && value.method === "turn/start"), false);
});

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

test("an externally owned attachment never falls through to an App Server writer", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-external-owner-only-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-external-owner-only-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        const response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize" ? { result: { clientId: "external-owner-test" } } : {}),
        };
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  const adapter = new CodexAdapter({
    hostId: "host_external_owner",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath, ownerRecoveryWindowMs: 0 },
  });
  t.after(() => adapter.dispose());
  await assert.rejects(() => adapter.sendMessageToExternalOwner!("thread-image", {
    requestId: "external-owner-image",
    content: "Review this",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  }), /another writer.*did not become reachable.*draft is unchanged/iu);
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start"), false);
});

test("Codex attachments use App Server first even while Desktop IPC exists", {
  skip: process.platform !== "win32",
}, async (t) => {
  const pipePath = `\\\\.\\pipe\\tethoq-desktop-present-${process.pid}-${randomUUID()}`;
  const desktopRequests: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => desktopRequests.push({ bytes: chunk.byteLength }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport = new FakeTransport();
  transport.methodResults.set("turn/start", { turn: { id: "app-server-image-turn" } });
  const adapter = new CodexAdapter({
    hostId: "host_desktop_closed",
    transportFactory: () => transport,
    desktopQueue: {
      statePath: join(tmpdir(), `tethoq-desktop-closed-${randomUUID()}.json`),
      pipePath,
    },
  });
  t.after(() => adapter.dispose());

  const result = await adapter.sendMessage("thread-image", {
    requestId: "desktop-closed-image",
    content: "Review this image",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  });

  assert.deepEqual(result, { accepted: true, providerTurnId: "app-server-image-turn", details: [] });
  const turnStart = transport.sent.find((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start") as Record<string, unknown> | undefined;
  assert.deepEqual(turnStart?.params, {
    threadId: "thread-image",
    clientUserMessageId: "desktop-closed-image",
    input: [
      { type: "text", text: "Review this image", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AQID" },
    ],
  });
  assert.deepEqual(desktopRequests, []);
});

test("an ownerless Desktop pipe lets App Server reclaim the image turn without user retry", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-writer-release-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-writer-release-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        writeDesktopResponse(socket, {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize" ? { result: { clientId: "writer-release-test" } } : {}),
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResponses.set("turn/start", [
    { error: { code: -32000, message: "thread thread-image already has an active writer" } },
    { result: { turn: { id: "reclaimed-image-turn" } } },
  ]);
  const adapter = new CodexAdapter({
    hostId: "host_writer_release",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath, ownerRecoveryWindowMs: 300, ownerRetryDelayMs: 1 },
  });
  t.after(() => adapter.dispose());
  const request = {
    requestId: "writer-release-image",
    content: "Review this image",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  };

  const result = await adapter.sendMessage("thread-image", request);
  assert.deepEqual(result, { accepted: true, providerTurnId: "reclaimed-image-turn", details: [] });
  const appServerStarts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start") as Record<string, unknown>[];
  assert.equal(appServerStarts.length, 2);
  assert.ok(appServerStarts.every((start) => (start.params as Record<string, unknown>).clientUserMessageId === request.requestId));
  assert.ok(appServerStarts.every((start) => JSON.stringify((start.params as Record<string, unknown>).input) === JSON.stringify((appServerStarts[0]?.params as Record<string, unknown>)?.input)));
  assert.equal(desktopRequests.filter((message) => message.method === "thread-owner-discovery").length, 1);
  assert.equal(desktopRequests.some((message) => message.method === "thread-follower-start-turn"), false);
});

test("an App Server active-writer race recovers plain text through the newly discovered Desktop owner", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-race-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-race-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  let ownerDiscoveries = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        if (request.method === "thread-owner-discovery") ownerDiscoveries += 1;
        const supportedVersion = request.method === "initialize"
          || (request.method === "thread-owner-discovery" && request.version === 1)
          || (request.method === "thread-follower-start-turn" && request.version === 2);
        const response = supportedVersion ? {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "owner-race-test" } }
            : request.method === "thread-owner-discovery" && ownerDiscoveries > 2
              ? { handledByClientId: "late-desktop-owner" }
              : request.method === "thread-follower-start-turn"
                ? { result: { result: { turn: { id: "desktop-race-turn" } } } }
                : {}),
        } : {
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "no-client-found",
        };
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResponses.set("turn/start", Array.from({ length: 3 }, () => ({
    error: { code: -32000, message: "thread thread-image already has an active writer" },
  })));
  const adapter = new CodexAdapter({
    hostId: "host_owner_race",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath },
  });
  t.after(() => adapter.dispose());
  adapter.configureClientTooling({
    definitions: [{ name: "ask_eyes", description: "Ask visual support", inputSchema: { type: "object" } }],
    async execute() { return { observation: "visible" }; },
    mcpServer() { throw new Error("not used"); },
  });
  transport.methodResults.set("thread/resume", { thread: { id: "thread-image" } });
  const request = {
    requestId: "owner-race-text",
    content: "Continue this existing chat",
  };

  const result = await adapter.sendMessage("thread-image", request);
  assert.deepEqual(result, { accepted: true, providerTurnId: "desktop-race-turn", details: [] });
  const appServerStarts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start") as Record<string, unknown>[];
  assert.equal(appServerStarts.length, 3);
  const ownerStarts = desktopRequests.filter((message) => message.method === "thread-follower-start-turn");
  assert.equal(ownerStarts.length, 1);
  const ownerStart = ownerStarts[0];
  const ownerRequest = (((ownerStart?.params as Record<string, unknown>)?.turnStart as Record<string, unknown>)?.request as Record<string, unknown>);
  assert.equal(ownerStart?.version, 2);
  assert.ok(desktopRequests.filter((message) => message.method === "thread-owner-discovery")
    .every((message) => message.version === 1));
  assert.equal(ownerRequest.clientUserMessageId, request.requestId);
  assert.deepEqual(ownerRequest.dynamicTools, [{
    type: "function",
    name: "ask_eyes",
    description: "Ask visual support",
    inputSchema: { type: "object" },
  }], "the Desktop-owned parent turn must receive the EYES tool definition");
  assert.ok(appServerStarts.every((start) => (start.params as Record<string, unknown>).clientUserMessageId === request.requestId));
  assert.ok(appServerStarts.every((start) => JSON.stringify((start.params as Record<string, unknown>).input) === JSON.stringify((appServerStarts[0]?.params as Record<string, unknown>)?.input)));
  assert.deepEqual(ownerRequest.input, (appServerStarts[0]?.params as Record<string, unknown>)?.input);
  assert.deepEqual(ownerRequest.input, [{ type: "text", text: request.content, text_elements: [] }]);
});

test("an App Server active-writer race keeps a Mesh tool turn on Tethoq's live connection", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-mesh-owner-race-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-mesh-owner-race-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        const supportedVersion = request.method === "initialize"
          || (request.method === "thread-owner-discovery" && request.version === 1)
          || (request.method === "thread-follower-start-turn" && request.version === 2);
        writeDesktopResponse(socket, supportedVersion ? {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "mesh-owner-race-test" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "desktop-owner" }
              : request.method === "thread-follower-start-turn"
                ? { result: { result: { turn: { id: "unexpected-desktop-mesh-turn" } } } }
                : {}),
        } : {
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "unsupported-request",
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResults.set("thread/resume", { thread: { id: "thread-mesh" } });
  transport.methodResponses.set("turn/start", Array.from({ length: 2 }, () => ({
    error: { code: -32000, message: "thread thread-mesh already has an active writer" },
  })));
  const adapter = new CodexAdapter({
    hostId: "host_mesh_owner_race",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath },
  });
  t.after(() => adapter.dispose());
  adapter.configureClientTooling({
    definitions: [{
      name: "mesh_dispatch_delegation",
      description: "Dispatch a prepared Mesh delegation",
      inputSchema: { type: "object" },
    }],
    async execute() { return { children: [] }; },
    mcpServer() { throw new Error("not used"); },
  });
  const request = {
    requestId: "same-mesh-owner-request",
    content: "Ask the selected worker to inspect this path.",
    clientToolOverrides: { mesh_dispatch_delegation: true },
  };

  const outcomes = await Promise.allSettled([
    adapter.sendMessage("thread-mesh", request),
    adapter.sendMessage("thread-mesh", request),
  ]);

  for (const outcome of outcomes) {
    assert.ok(outcome.status === "rejected");
    const error = outcome.reason as { readonly code?: unknown; readonly retryable?: unknown; readonly message?: unknown };
    assert.equal(error.code, "EXTERNAL_WRITER_UNAVAILABLE");
    assert.equal(error.retryable, true);
    assert.match(String(error.message), /close the task in Codex Desktop.*then retry/iu);
  }
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/resume").length, 1,
  "coalesced retries must prepare the existing task only once");
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 1,
  "coalesced retries must make exactly one App Server turn attempt");
  assert.equal(desktopRequests.filter((message) => message.method === "thread-follower-start-turn").length, 0,
  "a Mesh turn cannot use Desktop's follower route without callback IPC");
});

test("concurrent retries with one request identity start only one Codex turn", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("turn/start", { turn: { id: "coalesced-turn" } });
  const adapter = new CodexAdapter({ hostId: "host_coalesced_send", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  const request = {
    requestId: "same-image-request",
    content: "Review once",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  };

  const [first, second] = await Promise.all([
    adapter.sendMessage("thread-coalesced", request),
    adapter.sendMessage("thread-coalesced", request),
  ]);

  assert.deepEqual(first, second);
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 1);
});

test("a pre-turn lineage rejection reaches the Desktop owner exactly once with the identical request", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-lineage-recovery-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-lineage-recovery-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        writeDesktopResponse(socket, {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "lineage-recovery-test" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "desktop-owner" }
              : request.method === "thread-follower-start-turn"
                ? { result: { result: { turn: { id: "desktop-lineage-turn" } } } }
                : {}),
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResponses.set("thread/resume", [{
    error: {
      code: -32603,
      message: "invalid paginated history lineage for thread-lineage: cycle detected",
    },
  }]);
  const adapter = new CodexAdapter({
    hostId: "host_lineage_recovery",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath, ownerRecoveryWindowMs: 0 },
  });
  t.after(() => adapter.dispose());
  adapter.configureClientTooling({
    definitions: [{ name: "ask_eyes", description: "Inspect an image", inputSchema: { type: "object" } }],
    async execute() { return { observation: "visible" }; },
    mcpServer() { throw new Error("not used"); },
  });
  const request = {
    requestId: "lineage-request-once",
    content: "Inspect this screenshot without losing it",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "max",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  };

  const [first, second] = await Promise.all([
    adapter.sendMessage("thread-lineage", request),
    adapter.sendMessage("thread-lineage", request),
  ]);

  assert.deepEqual(first, { accepted: true, providerTurnId: "desktop-lineage-turn", details: [] });
  assert.deepEqual(second, first);
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/resume").length, 1);
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 0,
  "a failed preflight must never issue an App Server turn/start");
  const desktopStarts = desktopRequests.filter((entry) => entry.method === "thread-follower-start-turn");
  assert.equal(desktopStarts.length, 1, "coalesced retries must produce one Desktop turn");
  const forwarded = ((((desktopStarts[0]?.params as Record<string, unknown>).turnStart as Record<string, unknown>).request) as Record<string, unknown>);
  assert.deepEqual(forwarded, {
    threadId: "thread-lineage",
    clientUserMessageId: request.requestId,
    input: [
      { type: "text", text: request.content, text_elements: [] },
      { type: "image", url: "data:image/png;base64,AQID" },
    ],
    model: request.modelId,
    effort: request.reasoningEffort,
    dynamicTools: [{ type: "function", name: "ask_eyes", description: "Inspect an image", inputSchema: { type: "object" } }],
  });
});

test("an ambiguous App Server turn-start never crosses over to Desktop", async (t) => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("turn/start");
  const adapter = new CodexAdapter({
    hostId: "host_ambiguous_app_server",
    requestTimeoutMs: 20,
    transportFactory: () => transport,
    desktopQueue: {
      statePath: join(tmpdir(), `tethoq-ambiguous-app-server-${randomUUID()}.json`),
      pipePath: `\\\\.\\pipe\\tethoq-ambiguous-app-server-${process.pid}-${randomUUID()}`,
      ownerRecoveryWindowMs: 0,
    },
  });
  t.after(() => adapter.dispose());

  await assert.rejects(() => adapter.sendMessage("thread-ambiguous", {
    requestId: "ambiguous-app-server-request",
    content: "Do not duplicate this",
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DELIVERY_UNKNOWN");
    assert.equal((error as { retryable?: boolean }).retryable, false);
    return true;
  });
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 1);
});

test("an exited App Server rejects promptly and the next request launches a fresh peer", async (t) => {
  const first = new FakeTransport();
  first.blockedMethods.add("turn/start");
  const second = new FakeTransport();
  second.methodResults.set("turn/start", { turn: { id: "fresh-turn" } });
  const transports = [first, second];
  let transportIndex = 0;
  const adapter = new CodexAdapter({
    hostId: "host_process_restart",
    requestTimeoutMs: 60_000,
    transportFactory: () => transports[transportIndex++]!,
  });
  t.after(() => adapter.dispose());
  const pending = adapter.sendMessage("thread-restart", { requestId: "before-exit", content: "Run once" });
  const deadline = Date.now() + 1_000;
  while (!first.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start") && Date.now() < deadline) await delay(5);

  first.crash(new Error("Codex App Server exited"));
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "DELIVERY_UNKNOWN");

  const result = await adapter.sendMessage("thread-restart", { requestId: "after-exit", content: "Continue safely" });
  assert.deepEqual(result, { accepted: true, providerTurnId: "fresh-turn", details: [] });
  assert.equal(transportIndex, 2);
});

test("a pre-delivery CLI failure without a Desktop owner fails closed", {
  skip: process.platform !== "win32",
}, async (t) => {
  const adapter = new CodexAdapter({
    hostId: "host_missing_cli",
    command: join(tmpdir(), `missing-codex-${randomUUID()}.exe`),
    desktopQueue: {
      statePath: join(tmpdir(), `tethoq-missing-cli-${randomUUID()}.json`),
      pipePath: `\\\\.\\pipe\\tethoq-missing-cli-${process.pid}-${randomUUID()}`,
      ownerRecoveryWindowMs: 0,
    },
  });
  t.after(() => adapter.dispose());

  await assert.rejects(() => adapter.sendMessage("thread-missing-cli", {
    requestId: "preserved-missing-cli-request",
    content: "Keep this draft intact",
  }), /pre-delivery task setup.*draft and attachments are unchanged/iu);
});

test("an ambiguous Desktop acknowledgement never falls through to another App Server start", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-ambiguous-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-ambiguous-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        writeDesktopResponse(socket, {
          type: "response",
          requestId: request.requestId,
          ...(request.method === "thread-follower-start-turn"
            ? { resultType: "error", error: "owner stopped responding after dispatch" }
            : {
                resultType: "success",
                ...(request.method === "initialize"
                  ? { result: { clientId: "ambiguous-test" } }
                  : request.method === "thread-owner-discovery"
                    ? { handledByClientId: "desktop-owner" }
                    : {}),
              }),
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResponses.set("turn/start", [{
    error: { code: -32000, message: "thread thread-image already has an active writer" },
  }]);
  const adapter = new CodexAdapter({
    hostId: "host_owner_ambiguous",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath, ownerRecoveryWindowMs: 100 },
  });
  t.after(() => adapter.dispose());

  await assert.rejects(() => adapter.sendMessage("thread-image", {
    requestId: "ambiguous-image",
    content: "Review this image",
    attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  }), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "DELIVERY_UNKNOWN");
    assert.match(String((error as { cause?: unknown }).cause), /stopped responding after dispatch/iu);
    return true;
  });
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 1);
  assert.equal(desktopRequests.filter((request) => request.method === "thread-follower-start-turn").length, 1);
});

test("a stale Desktop owner is rediscovered without changing or duplicating the image request", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-stale-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-stale-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  const sockets = new Set<Socket>();
  const desktopRequests: Record<string, unknown>[] = [];
  let discoveries = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        desktopRequests.push(request);
        if (request.method === "thread-owner-discovery") discoveries += 1;
        writeDesktopResponse(socket, {
          type: "response",
          requestId: request.requestId,
          ...(request.method === "thread-follower-start-turn" && request.targetClientId === "stale-owner"
            ? { resultType: "error", error: "NoClientFound" }
            : {
                resultType: "success",
                ...(request.method === "initialize"
                  ? { result: { clientId: "stale-owner-test" } }
                  : request.method === "thread-owner-discovery"
                    ? { handledByClientId: discoveries === 1 ? "stale-owner" : "fresh-owner" }
                    : request.method === "thread-follower-start-turn"
                      ? { result: { result: { turn: { id: "fresh-owner-turn" } } } }
                      : {}),
              }),
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeTransport();
  transport.methodResponses.set("turn/start", Array.from({ length: 2 }, () => ({
    error: { code: -32000, message: "thread thread-image already has an active writer" },
  })));
  const adapter = new CodexAdapter({
    hostId: "host_owner_stale",
    transportFactory: () => transport,
    desktopQueue: { statePath, pipePath, ownerRecoveryWindowMs: 300, ownerRetryDelayMs: 1 },
  });
  t.after(() => adapter.dispose());
  const request = {
    requestId: "stale-owner-image",
    content: "Review these images",
    attachments: [
      { name: "first.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 },
      { name: "second.png", mimeType: "image/png", dataBase64: "BAUG", byteLength: 3 },
    ],
  };

  const result = await adapter.sendMessage("thread-image", request);
  assert.deepEqual(result, { accepted: true, providerTurnId: "fresh-owner-turn", details: [] });
  const appServerStarts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start") as Record<string, unknown>[];
  const desktopStarts = desktopRequests.filter((message) => message.method === "thread-follower-start-turn");
  assert.equal(appServerStarts.length, 2);
  assert.equal(desktopStarts.length, 2);
  assert.deepEqual(desktopStarts.map((start) => start.targetClientId), ["stale-owner", "fresh-owner"]);
  assert.deepEqual(desktopStarts.map((start) => start.version), [2, 2]);
  const expectedInput = (appServerStarts[0]?.params as Record<string, unknown>).input;
  assert.ok(appServerStarts.every((start) => (start.params as Record<string, unknown>).clientUserMessageId === request.requestId));
  assert.ok(appServerStarts.every((start) => JSON.stringify((start.params as Record<string, unknown>).input) === JSON.stringify(expectedInput)));
  assert.ok(desktopStarts.every((start) => {
    const forwarded = (((start.params as Record<string, unknown>).turnStart as Record<string, unknown>).request as Record<string, unknown>);
    return forwarded.clientUserMessageId === request.requestId && JSON.stringify(forwarded.input) === JSON.stringify(expectedInput);
  }));
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
  await delay(15);
  assert.equal(transports[0]?.closeCalls, 1);
  await adapter.getAuthStatus();
  assert.equal(transports.length, 2);
  await adapter.dispose();
});

test("Codex keeps rollout watching active after releasing an externally owned idle app-server", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-idle-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`, "utf8");
  const thread = {
    id: threadId,
    sessionId: threadId,
    preview: "Externally watched task",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: rollout,
    cwd: directory,
    cliVersion: "0.148.0",
  };
  const transports: FakeTransport[] = [];
  const adapter = new CodexAdapter({
    hostId: "host_external_watch",
    idleReleaseMs: 5,
    transportFactory: () => {
      const transport = new FakeTransport();
      transport.methodResults.set("thread/list", { data: [thread], nextCursor: null });
      transports.push(transport);
      return transport;
    },
    localActivity: { codexHome: directory, pollIntervalMs: 5, isLockHeld: async () => true },
  });
  t.after(() => adapter.dispose());
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.listSessions();
  assert.equal(await adapter.watchSession(threadId), true);
  await delay(20);
  assert.equal(transports[0]?.closeCalls, 1, "rollout watching alone must not pin App Server");

  await appendFile(rollout, [
    `${JSON.stringify({
      timestamp: "2026-08-25T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "answer-after-peer-close",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Watcher stayed live" }],
      },
    })}\n`,
    `${JSON.stringify({
      timestamp: "2026-08-25T12:00:00.100Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-after-peer-close", last_agent_message: "Watcher stayed live" },
    })}\n`,
  ].join(""), "utf8");
  const deadline = Date.now() + 500;
  while (!events.some((event) => event.type === "message.completed" && event.payload.text === "Watcher stayed live") && Date.now() < deadline) {
    await delay(5);
  }
  assert.equal(events.some((event) => event.type === "message.completed" && event.payload.text === "Watcher stayed live"), true);

  await adapter.getAuthStatus();
  assert.equal(transports.length, 2, "the next native capability must reopen App Server lazily");
});

test("Codex keeps App Server alive for an owned active turn and releases it after completion", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("turn/start", { turn: { id: "owned-turn" } });
  const adapter = new CodexAdapter({ hostId: "host_owned_turn", idleReleaseMs: 5, transportFactory: () => transport });
  t.after(() => adapter.dispose());

  await adapter.sendMessage("owned-thread", { requestId: "owned-message", content: "Work on this" });
  assert.equal(adapter.ownsActiveTurn("owned-thread"), true);
  await delay(15);
  assert.equal(transport.closeCalls, 0, "an owned active turn must keep its App Server connection");

  transport.push({ method: "turn/completed", params: { threadId: "owned-thread", turn: { id: "owned-turn" } } });
  await delay(15);
  assert.equal(adapter.ownsActiveTurn("owned-thread"), false);
  assert.equal(transport.closeCalls, 1, "completion removes the active-turn blocker");
});

test("Codex preserves interrupted and failed turn outcomes instead of reporting every terminal turn as completed", async (t) => {
  const { adapter, transport, events } = await adapterWithPeer();
  t.after(() => adapter.dispose());

  transport.push({ method: "turn/completed", params: { threadId: "terminal-thread", turn: { id: "completed-turn", status: "completed" } } });
  transport.push({ method: "turn/completed", params: { threadId: "terminal-thread", turn: { id: "interrupted-turn", status: "interrupted" } } });
  transport.push({ method: "turn/completed", params: { threadId: "terminal-thread", turn: { id: "failed-turn", status: "failed" } } });
  await delay(10);

  const terminal = events.filter((event) => event.providerSessionId === "terminal-thread");
  assert.deepEqual(terminal.map((event) => event.type), ["agent.completed", "agent.interrupted", "agent.error"]);
  assert.deepEqual(terminal.map((event) => event.payload.turnId), ["completed-turn", "interrupted-turn", "failed-turn"]);
  assert.deepEqual(terminal.map((event) => (event.payload.turn as Record<string, unknown>).status), ["completed", "interrupted", "failed"]);
});

test("Codex waits for approval and user input before releasing App Server", async (t) => {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter({ hostId: "host_pending_requests", idleReleaseMs: 5, transportFactory: () => transport });
  t.after(() => adapter.dispose());
  await adapter.getAuthStatus();

  transport.push({
    id: "pending-approval",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "pending-thread", turnId: "pending-turn", itemId: "command", command: "npm test", cwd: "C:\\workspace", reason: "verify" },
  });
  transport.push({
    id: "pending-input",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "pending-thread",
      turnId: "pending-turn",
      itemId: "question",
      questions: [{ id: "choice", header: "Choose", question: "Which?", isOther: false, isSecret: false, options: [] }],
      isBlocking: true,
      autoResolutionMs: null,
    },
  });
  await delay(10);
  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal(transport.closeCalls, 0, "unanswered server requests must block closure");

  await adapter.respondToApproval({ providerRequestId: "pending-approval", choiceId: "approve" });
  await delay(15);
  assert.equal(transport.closeCalls, 0, "settling one request must not abandon another pending request");

  await adapter.respondToUserInput({ providerRequestId: "pending-input", answers: { choice: ["one"] } });
  await delay(15);
  assert.equal(transport.closeCalls, 1, "App Server may close only after every pending request settles");
});

test("Codex never closes App Server during an active RPC", async (t) => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("account/read");
  const adapter = new CodexAdapter({ hostId: "host_active_rpc", idleReleaseMs: 5, transportFactory: () => transport });
  t.after(() => adapter.dispose());

  const auth = adapter.getAuthStatus();
  while (!transport.sent.some((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "account/read")) {
    await delay(1);
  }
  await adapter.releaseIdleResources();
  await delay(15);
  assert.equal(transport.closeCalls, 0, "an in-flight request must block closure");

  const request = transport.sent.find((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "account/read") as Record<string, unknown>;
  transport.push({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });
  await auth;
  await delay(15);
  assert.equal(transport.closeCalls, 1, "the completed RPC schedules the normal idle release");
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

test("Codex terminal fallback does not duplicate a canonical final answer", () => {
  const base = {
    sessionId: "host_1/codex/thread_1",
    role: "assistant" as const,
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.000Z",
    status: "completed" as const,
  };
  const canonical = [{ ...base, id: "canonical", providerMessageId: "canonical", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { phase: "final_answer" } }];
  const fallback = [{ ...base, id: "fallback", providerMessageId: "task-complete-turn", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { phase: "final_answer", terminalFallback: true } }];
  assert.deepEqual(mergeCodexMessageHistory(canonical, fallback), canonical);
});

test("Codex rollout final-answer metadata enriches the identical canonical message", () => {
  const base = {
    sessionId: "host_1/codex/thread_1",
    role: "assistant" as const,
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.000Z",
    status: "completed" as const,
  };
  const canonical = [{ ...base, id: "canonical", providerMessageId: "answer-1", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { type: "agentMessage" } }];
  const observed = [{ ...base, id: "observed", providerMessageId: "answer-1", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { phase: "final_answer" } }];

  const merged = mergeCodexMessageHistory(canonical, observed);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "canonical");
  assert.deepEqual(merged[0]?.nativeMetadata, { type: "agentMessage", phase: "final_answer" });
});

test("Codex rollout chronology replaces task-start fallback time and keeps the final answer in the newest page", () => {
  const sessionId = "host_1/codex/thread_1";
  const canonical = [{
    id: "canonical-final",
    sessionId,
    providerMessageId: "answer-1",
    role: "assistant" as const,
    createdAt: "2026-08-23T17:04:17.000Z",
    completedAt: "2026-08-23T17:04:17.000Z",
    parts: [{ type: "text" as const, text: "The persisted final reply" }],
    status: "completed" as const,
    nativeMetadata: { type: "agentMessage", tethoqCodexTimestampSource: "thread" },
  }];
  const observed = [
    ...Array.from({ length: 45 }, (_, index) => ({
      id: `earlier-${index}`,
      sessionId,
      providerMessageId: `earlier-${index}`,
      role: "tool" as const,
      createdAt: new Date(Date.UTC(2026, 7, 25, 1, 22, index)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 7, 25, 1, 22, index)).toISOString(),
      parts: [{ type: "tool" as const, name: "check", status: "completed" as const }],
      status: "completed" as const,
      nativeMetadata: {},
    })),
    {
      ...canonical[0]!,
      id: "rollout-final",
      createdAt: "2026-08-25T01:23:08.000Z",
      completedAt: "2026-08-25T01:23:08.000Z",
      nativeMetadata: { phase: "final_answer" },
    },
  ];

  const merged = mergeCodexMessageHistory(canonical, observed);
  const newestPage = merged.slice(-40);

  assert.equal(merged.at(-1)?.id, "canonical-final");
  assert.equal(merged.at(-1)?.createdAt, "2026-08-25T01:23:08.000Z");
  assert.equal(merged.at(-1)?.nativeMetadata.phase, "final_answer");
  assert.equal(newestPage.some((message) => message.providerMessageId === "answer-1"), true);
});

test("Codex commentary metadata cannot downgrade a canonical final answer", () => {
  const base = {
    sessionId: "host_1/codex/thread_1",
    role: "assistant" as const,
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.000Z",
    status: "completed" as const,
  };
  const canonical = [{ ...base, id: "canonical", providerMessageId: "answer-1", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { phase: "final_answer" } }];
  const observed = [{ ...base, id: "observed", providerMessageId: "answer-1", parts: [{ type: "text" as const, text: "Finished once" }], nativeMetadata: { phase: "commentary" } }];

  const merged = mergeCodexMessageHistory(canonical, observed);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.nativeMetadata.phase, "final_answer");
});

test("Codex rollout attachment data enriches an identical canonical image placeholder", () => {
  const base = {
    sessionId: "host_1/codex/thread_1",
    providerMessageId: "user-image-1",
    role: "user" as const,
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.000Z",
    status: "completed" as const,
    nativeMetadata: {},
  };
  const canonical = [{ ...base, id: "canonical", parts: [
    { type: "text" as const, text: "Review this" },
    { type: "image" as const, name: "screen.png", mimeType: "image/png" },
  ] }];
  const observed = [{ ...base, id: "observed", parts: [
    { type: "text" as const, text: "Review this" },
    { type: "image" as const, name: "screen.png", mimeType: "image/png", uri: "data:image/png;base64,AQID" },
  ] }];

  const merged = mergeCodexMessageHistory(canonical, observed);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "observed");
  assert.deepEqual(merged[0]?.parts, observed[0]?.parts);
});

test("Codex merges one user item even when its two histories order attachment parts differently", () => {
  const base = {
    sessionId: "host_1/codex/thread_1",
    providerMessageId: "canonical-user-item",
    role: "user" as const,
    completedAt: "2026-08-25T04:00:14.865Z",
    status: "completed" as const,
  };
  const canonical = [{
    ...base,
    id: "canonical-user",
    createdAt: "2026-08-23T17:04:17.000Z",
    parts: [{ type: "image" as const, name: "screen.png", mimeType: "image/png" }, { type: "text" as const, text: "Why did this disappear?" }],
    nativeMetadata: { tethoqCodexTimestampSource: "thread" },
  }];
  const observed = [{
    ...base,
    id: "rollout-user",
    createdAt: "2026-08-25T04:00:14.865Z",
    parts: [{ type: "text" as const, text: "Why did this disappear?" }, { type: "image" as const, name: "screen.png", mimeType: "image/png", uri: "data:image/png;base64,AQID" }],
    nativeMetadata: {},
  }];

  const merged = mergeCodexMessageHistory(canonical, observed);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "rollout-user");
  assert.equal(merged[0]?.createdAt, observed[0]?.createdAt);
  assert.deepEqual(merged[0]?.parts, observed[0]?.parts);
});

test("Codex preserves the App Server's reported GPT-5.6 Sol modalities", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("model/list", {
    data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", inputModalities: ["text", "image"] }],
    nextCursor: null,
  });

  const models = await adapter.listModels();

  assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
  await adapter.dispose();
});

test("Codex compaction waits past acknowledgment for its matching item and turn completion", async () => {
  const { adapter, transport } = await adapterWithPeer();

  let settled = false;
  const pending = adapter.compactSession("thread-context-limit").then(() => { settled = true; });
  const duplicate = adapter.compactSession("thread-context-limit");
  await delay(10);
  assert.equal(settled, false, "acceptance is not completion");
  emitCompaction(transport, "other-thread", "other-turn");
  transport.push({ method: "turn/started", params: { threadId: "thread-context-limit", turn: { id: "compact-turn" } } });
  transport.push({ method: "item/started", params: { threadId: "thread-context-limit", turnId: "compact-turn", item: { type: "contextCompaction", id: "compact-item" } } });
  transport.push({ method: "item/completed", params: { threadId: "thread-context-limit", turnId: "wrong-turn", item: { type: "contextCompaction", id: "compact-item" } } });
  transport.push({ method: "turn/completed", params: { threadId: "thread-context-limit", turn: { id: "wrong-turn", status: "completed" } } });
  await delay(5);
  assert.equal(settled, false);
  transport.push({ method: "item/completed", params: { threadId: "thread-context-limit", turnId: "compact-turn", item: { type: "contextCompaction", id: "compact-item" } } });
  await delay(5);
  assert.equal(settled, false, "the native turn must finish before another can start");
  transport.push({ method: "turn/completed", params: { threadId: "thread-context-limit", turn: { id: "compact-turn", status: "completed" } } });
  await Promise.all([pending, duplicate]);

  const request = transport.sent.find((message) =>
    typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/compact/start"
  ) as Record<string, unknown> | undefined;
  assert.ok(request);
  assert.deepEqual(request.params, { threadId: "thread-context-limit" });
  assert.equal(transport.sent.filter(m => (m as Record<string, unknown>).method === "thread/compact/start").length, 1);
  await adapter.dispose();
});

function emitCompaction(transport: FakeTransport, threadId: string, turnId: string): void {
  transport.push({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
  const item = { id: `${turnId}-item`, type: "contextCompaction" };
  transport.push({ method: "item/started", params: { threadId, turnId, item } });
  transport.push({ method: "item/completed", params: { threadId, turnId, item } });
  transport.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

test("Codex compaction handles completion before acknowledgment without emitting a new user turn", async (t) => {
  const transport = new FakeTransport();
  transport.blockedMethods.add("thread/compact/start");
  const adapter = new CodexAdapter({ hostId: "host", transportFactory: () => transport, idleReleaseMs: 5 });
  t.after(() => adapter.dispose());
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, event => { events.push(event); });
  const pending = adapter.compactSession("thread");
  await delay(15);
  assert.equal(transport.closeCalls, 0);
  emitCompaction(transport, "thread", "compact-turn");
  const request = transport.sent.find(m => (m as Record<string, unknown>).method === "thread/compact/start") as Record<string, unknown>;
  transport.push({ id: request.id, result: {} });
  await pending;
  assert.equal(events.some(e => e.type === "agent.completed" || e.type.startsWith("message.")), false);
});

for (const outcome of ["failed", "interrupted", "disconnect", "dispose", "timeout"] as const) {
  test(`Codex compaction rejects ${outcome} and releases its pending operation`, async (t) => {
    const transport = new FakeTransport();
    const adapter = new CodexAdapter({ hostId: "host", transportFactory: () => transport, compactionTimeoutMs: 80, idleReleaseMs: 5 });
    t.after(() => adapter.dispose());
    const pending = adapter.compactSession("thread");
    const rejected = assert.rejects(pending, /compaction|disconnected|disposed/i);
    await delay(15);
    assert.equal(transport.closeCalls, 0, "pending compaction must keep an idle transport alive after ack");
    if (outcome === "disconnect") transport.crash(new Error("disconnected during compaction"));
    else if (outcome === "dispose") await adapter.dispose();
    else if (outcome !== "timeout") {
      transport.push({ method: "turn/started", params: { threadId: "thread", turn: { id: "failed-turn" } } });
      transport.push({ method: "turn/completed", params: { threadId: "thread", turn: { id: "failed-turn", status: outcome } } });
    }
    await rejected;
    if (outcome === "failed" || outcome === "interrupted") {
      const retry = adapter.compactSession("thread");
      await delay(5);
      emitCompaction(transport, "thread", "retry-turn");
      await retry;
    }
  });
}

test("Codex resumes an unloaded persisted thread and retries its metadata read exactly once", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/read", [
    { error: { code: -32600, message: "Thread thread-read-persisted is not loaded" } },
    { result: {
      thread: {
        id: "thread-read-persisted",
        sessionId: "thread-read-persisted",
        preview: "Persisted metadata",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        cwd: "C:\\workspace",
        cliVersion: "test",
        turns: [],
      },
    } },
  ]);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-read-persisted" } });

  const session = await adapter.getSession("thread-read-persisted");

  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/read", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
  assert.deepEqual(calls[0]?.params, { threadId: "thread-read-persisted", includeTurns: false });
  assert.deepEqual(calls[2]?.params, calls[0]?.params, "the retry must preserve the metadata-only read");
  assert.deepEqual(calls[1]?.params, { threadId: "thread-read-persisted" });
  assert.equal(session.providerSessionId, "thread-read-persisted");
  await adapter.dispose();
});

test("Codex getSession preserves unrelated read errors and mismatched resume failures", async () => {
  const unrelated = await adapterWithPeer();
  unrelated.transport.methodResponses.set("thread/read", [
    { error: { code: -32603, message: "Metadata read denied by workspace policy" } },
  ]);
  await assert.rejects(
    unrelated.adapter.getSession("thread-read-policy"),
    /Metadata read denied by workspace policy/iu,
  );
  const unrelatedCalls = unrelated.transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/read", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(unrelatedCalls.map((call) => call.method), ["thread/read"]);
  await unrelated.adapter.dispose();

  const mismatched = await adapterWithPeer();
  mismatched.transport.methodResponses.set("thread/read", [
    { error: { code: -32600, message: "thread not found: thread-read-mismatch" } },
  ]);
  mismatched.transport.methodResults.set("thread/resume", { thread: { id: "different-thread" } });
  await assert.rejects(
    mismatched.adapter.getSession("thread-read-mismatch"),
    /Codex resumed a different thread ID/iu,
  );
  const mismatchedCalls = mismatched.transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/read", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(mismatchedCalls.map((call) => call.method), ["thread/read", "thread/resume"]);
  await mismatched.adapter.dispose();
});

test("Codex getSession preserves a second missing-thread failure after one retry", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/read", [
    { error: { code: -32600, message: "thread not found: thread-read-deleted" } },
    { error: { code: -32600, message: "thread not found: thread-read-deleted" } },
  ]);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-read-deleted" } });

  await assert.rejects(
    adapter.getSession("thread-read-deleted"),
    /thread not found: thread-read-deleted/iu,
  );
  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/read", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
  await adapter.dispose();
});

test("Codex resumes an unloaded persisted thread and retries compaction exactly once", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/compact/start", [
    { error: { code: -32600, message: "thread not found: thread-compaction-persisted" } },
    { result: {} },
  ]);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-compaction-persisted" } });

  const pending = adapter.compactSession("thread-compaction-persisted");
  await delay(15);
  emitCompaction(transport, "thread-compaction-persisted", "compact-retry");
  await pending;

  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null &&
    ["thread/compact/start", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/compact/start", "thread/resume", "thread/compact/start"]);
  assert.deepEqual(calls[0]?.params, calls[2]?.params, "the retry must preserve the exact task id");
  assert.deepEqual(calls[1]?.params, { threadId: "thread-compaction-persisted" });
  await adapter.dispose();
});

test("Codex preserves a missing-thread compaction failure after one resume attempt", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/compact/start", [
    { error: { code: -32600, message: "thread not found: thread-compaction-deleted" } },
  ]);
  transport.methodResponses.set("thread/resume", [
    { error: { code: -32600, message: "thread not found: thread-compaction-deleted" } },
  ]);

  await assert.rejects(
    adapter.compactSession("thread-compaction-deleted"),
    /thread not found: thread-compaction-deleted/iu,
  );
  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null &&
    ["thread/compact/start", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/compact/start", "thread/resume"]);
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

test("Codex scheduled retry does not resend after the accepted turn response was lost", async () => {
  const request = {
    requestId: "schedule_codex_exactly_once",
    content: "Run the scheduled Codex task\nwith normalized lines",
    metadata: { tethoqScheduledTaskId: "schedule_codex_exactly_once" },
  } as const;

  const firstTransport = new FakeTransport();
  firstTransport.methodResults.set("thread/read", { thread: { turns: [] } });
  firstTransport.blockedMethods.add("turn/start");
  const firstAdapter = new CodexAdapter({
    hostId: "host_schedule_first",
    requestTimeoutMs: 1_000,
    transportFactory: () => firstTransport,
  });
  const interrupted = firstAdapter.sendMessage("thread-scheduled", request).then(
    () => null,
    (error: unknown) => error,
  );
  while (!firstTransport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start")) {
    await delay(1);
  }
  await firstAdapter.dispose();
  assert.ok(await interrupted instanceof Error, "losing the turn/start response must not report acceptance");

  const retryTransport = new FakeTransport();
  retryTransport.methodResults.set("thread/read", {
    thread: {
      turns: [{
        id: "turn-scheduled-persisted",
        items: [{
          type: "userMessage",
          id: request.requestId,
          content: [{ type: "text", text: "  Run the scheduled Codex task\r\nwith normalized lines \r\n" }],
        }],
      }],
    },
  });
  const retryAdapter = new CodexAdapter({ hostId: "host_schedule_retry", transportFactory: () => retryTransport });
  const retried = await retryAdapter.sendMessage("thread-scheduled", request);

  assert.deepEqual(retried, {
    accepted: true,
    providerTurnId: "turn-scheduled-persisted",
    details: ["Codex already accepted this scheduled prompt."],
  });
  assert.equal(retryTransport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start"), false);
  const historyRead = retryTransport.sent.find((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read") as Record<string, unknown> | undefined;
  assert.deepEqual(historyRead?.params, { threadId: "thread-scheduled", includeTurns: true });
  await retryAdapter.dispose();
});

test("Codex scheduled retry replaces a lineage-incompatible peer before checking exact-once history", async () => {
  const request = {
    requestId: "schedule_codex_lineage_retry",
    content: "Run this scheduled prompt exactly once",
    metadata: { tethoqScheduledTaskId: "schedule_codex_lineage_retry" },
  } as const;
  const stale = new FakeTransport();
  stale.methodResponses.set("thread/read", [{
    error: { code: -32603, message: "invalid paginated history lineage for thread-scheduled: cycle detected" },
  }]);
  const fresh = new FakeTransport();
  fresh.methodResults.set("thread/read", {
    thread: {
      turns: [{
        id: "persisted-after-upgrade",
        items: [{ type: "userMessage", id: request.requestId, content: [{ type: "text", text: request.content }] }],
      }],
    },
  });
  const transports = [stale, fresh];
  let transportIndex = 0;
  const adapter = new CodexAdapter({
    hostId: "host_schedule_lineage_retry",
    transportFactory: () => transports[transportIndex++]!,
  });

  const result = await adapter.sendMessage("thread-scheduled", request);

  assert.deepEqual(result, {
    accepted: true,
    providerTurnId: "persisted-after-upgrade",
    details: ["Codex already accepted this scheduled prompt."],
  });
  assert.equal(transportIndex, 2);
  assert.equal(stale.closeCalls, 1);
  assert.equal(transports.some((transport) => transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start")), false, "history recovery must never duplicate the write");
  await adapter.dispose();
});

test("Codex scheduled first delivery starts once after replacing a lineage-incompatible peer", async () => {
  const request = {
    requestId: "schedule_codex_lineage_first_delivery",
    content: "Run after the provider upgrade",
    metadata: { tethoqScheduledTaskId: "schedule_codex_lineage_first_delivery" },
  } as const;
  const stale = new FakeTransport();
  stale.methodResponses.set("thread/read", [{
    error: { code: -32603, message: "invalid paginated history lineage for thread-scheduled: cycle detected" },
  }]);
  const fresh = new FakeTransport();
  fresh.methodResults.set("thread/read", { thread: { turns: [] } });
  fresh.methodResults.set("turn/start", { turn: { id: "fresh-scheduled-turn" } });
  const transports = [stale, fresh];
  let transportIndex = 0;
  const adapter = new CodexAdapter({
    hostId: "host_schedule_lineage_first_delivery",
    transportFactory: () => transports[transportIndex++]!,
  });

  const result = await adapter.sendMessage("thread-scheduled", request);

  assert.deepEqual(result, { accepted: true, providerTurnId: "fresh-scheduled-turn", details: [] });
  assert.equal(stale.closeCalls, 1);
  assert.equal(stale.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start"), false);
  assert.equal(fresh.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start").length, 1);
  await adapter.dispose();
});

test("Codex scheduled first turn proceeds while its new thread history is not materialized", async () => {
  const request = {
    requestId: "schedule_codex_new_thread",
    content: "Run this newly scheduled Codex task",
    metadata: { tethoqScheduledTaskId: "schedule_codex_new_thread" },
  } as const;
  const transport = new FakeTransport();
  transport.methodResponses.set("thread/read", [{
    error: {
      code: -32603,
      message: "thread thread-scheduled-new is not materialized yet; includeTurns is unavailable before first user message",
    },
  }]);
  transport.methodResults.set("turn/start", { turn: { id: "turn-scheduled-new" } });
  const adapter = new CodexAdapter({ hostId: "host_schedule_new_thread", transportFactory: () => transport });

  const result = await adapter.sendMessage("thread-scheduled-new", request);

  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-scheduled-new", details: [] });
  const relevantCalls = transport.sent.filter((message) => typeof message === "object" && message !== null
    && ["thread/read", "thread/resume", "turn/start"].includes(String((message as Record<string, unknown>).method))) as Record<string, unknown>[];
  assert.deepEqual(relevantCalls.map((call) => call.method), ["thread/read", "turn/start"]);
  assert.deepEqual(relevantCalls[0]?.params, { threadId: "thread-scheduled-new", includeTurns: true });
  assert.deepEqual(relevantCalls[1]?.params, {
    threadId: "thread-scheduled-new",
    clientUserMessageId: request.requestId,
    input: [{ type: "text", text: request.content, text_elements: [] }],
  });
  await adapter.dispose();
});

test("Codex scheduled retry ignores unrelated historical user turns", async () => {
  const request = {
    requestId: "schedule_codex_after_history",
    content: "Run this new scheduled Codex task",
    metadata: { tethoqScheduledTaskId: "schedule_codex_after_history" },
  } as const;
  const transport = new FakeTransport();
  transport.methodResults.set("thread/read", {
    thread: {
      turns: [{
        id: "unrelated-turn",
        items: [{ type: "userMessage", id: "an-older-request", content: [{ type: "text", text: request.content }] }],
      }],
    },
  });
  transport.methodResults.set("turn/start", { turn: { id: "new-scheduled-turn" } });
  const adapter = new CodexAdapter({ hostId: "host_schedule_unrelated_history", transportFactory: () => transport });

  const result = await adapter.sendMessage("thread-scheduled-history", request);

  assert.deepEqual(result, { accepted: true, providerTurnId: "new-scheduled-turn", details: [] });
  const turnStarts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start");
  assert.equal(turnStarts.length, 1);
  await adapter.dispose();
});

test("Codex scheduled retry ignores matching request identity with incompatible content", async () => {
  const request = {
    requestId: "schedule_codex_wrong_content",
    content: "Run the intended scheduled Codex task",
    metadata: { tethoqScheduledTaskId: "schedule_codex_wrong_content" },
  } as const;
  const transport = new FakeTransport();
  transport.methodResults.set("thread/read", {
    thread: {
      turns: [{
        id: "wrong-content-turn",
        items: [{ type: "userMessage", id: request.requestId, content: [{ type: "text", text: "A different prompt" }] }],
      }],
    },
  });
  transport.methodResults.set("turn/start", { turn: { id: "correct-scheduled-turn" } });
  const adapter = new CodexAdapter({ hostId: "host_schedule_wrong_content", transportFactory: () => transport });

  const result = await adapter.sendMessage("thread-scheduled-wrong-content", request);

  assert.deepEqual(result, { accepted: true, providerTurnId: "correct-scheduled-turn", details: [] });
  const turnStarts = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start");
  assert.equal(turnStarts.length, 1);
  await adapter.dispose();
});

test("Codex scheduled send fails closed when native history cannot be verified", async () => {
  const transport = new FakeTransport();
  transport.methodResponses.set("thread/read", [
    { error: { code: -32603, message: "Scheduled history unavailable" } },
  ]);
  const adapter = new CodexAdapter({ hostId: "host_schedule_history_failure", transportFactory: () => transport });

  await assert.rejects(
    adapter.sendMessage("thread-scheduled", {
      requestId: "schedule_codex_history_failure",
      content: "Do not duplicate this scheduled task",
      metadata: { tethoqScheduledTaskId: "schedule_codex_history_failure" },
    }),
    /Scheduled history unavailable/u,
  );
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/start"), false);
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
    async execute(providerId, providerSessionId, tool, input, context) {
      calls.push({ providerId, providerSessionId, tool, input, context });
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
  assert.deepEqual(calls, [{
    providerId: "codex",
    providerSessionId: "thread-tools",
    tool: "mesh_list_children",
    input: {},
    context: { callId: "tool-call-one", lifecycleOwner: "provider" },
  }]);
  assert.deepEqual(sentResult(transport, "tool-call-one"), { contentItems: [{ type: "inputText", text: "{\"children\":[]}" }], success: true });
  await adapter.dispose();
});

test("Codex hot-applies client tools to an existing task before its next turn", async () => {
  const { adapter, transport } = await adapterWithPeer();
  const tooling: ProviderClientTooling = {
    definitions: [{ name: "ask_eyes", description: "Ask visual support", inputSchema: { type: "object" } }],
    async execute() { return { observation: "visible" }; },
    mcpServer() { throw new Error("not used"); },
  };
  adapter.configureClientTooling(tooling);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-existing" } });
  transport.methodResults.set("turn/start", { turn: { id: "turn-existing" } });

  await adapter.sendMessage("thread-existing", { requestId: "existing-1", content: "Use EYES" });
  await adapter.sendMessage("thread-existing", { requestId: "existing-2", content: "Continue" });

  const calls = transport.sent.filter((message) => typeof message === "object" && message !== null
    && ["thread/resume", "turn/start"].includes(String((message as Record<string, unknown>).method))) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start", "turn/start"]);
  assert.deepEqual(calls[0]?.params, {
    threadId: "thread-existing",
    dynamicTools: [{
      type: "function",
      name: "ask_eyes",
      description: "Ask visual support",
      inputSchema: { type: "object" },
    }],
  });
  await adapter.dispose();
});

test("Codex keeps an isolated eyes session free of client and MCP tools through its first send", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/start", { thread: { id: "thread-eyes", preview: "", status: { type: "idle" }, createdAt: 1, updatedAt: 1, cwd: "C:\\workspace" } });
  transport.methodResults.set("turn/start", { turn: { id: "turn-eyes" } });
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
    firstInstruction: "Inspect the attached image.",
  });
  const start = transport.sent.find((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "thread/start") as Record<string, unknown>;
  assert.deepEqual(start.params, {
    cwd: "C:\\workspace",
    model: "gpt-vision",
    developerInstructions: "Act only as visual support.",
    ephemeral: true,
    config: { mcp_servers: {} },
  });
  const helperCalls = transport.sent.filter((message) => typeof message === "object" && message !== null
    && ["thread/resume", "turn/start"].includes(String((message as Record<string, unknown>).method))) as Record<string, unknown>[];
  assert.deepEqual(helperCalls.map((call) => call.method), ["turn/start"], "the first helper send must not resume with bridge client tools");
  const helperTurnParams = helperCalls[0]?.params as Record<string, unknown>;
  assert.match(String(helperTurnParams.clientUserMessageId), /^create_/u);
  assert.deepEqual({ ...helperTurnParams, clientUserMessageId: "<generated>" }, {
    threadId: "thread-eyes",
    clientUserMessageId: "<generated>",
    input: [{ type: "text", text: "Inspect the attached image.", text_elements: [] }],
    model: "gpt-vision",
  });
  await adapter.dispose();
});

test("Codex keeps restored EYES and EARS helpers isolated on their first internal send", async () => {
  const { adapter, transport } = await adapterWithPeer();
  adapter.configureClientTooling({
    definitions: [{ name: "ask_eyes", description: "Visual support", inputSchema: { type: "object" } }],
    async execute() { return {}; },
    mcpServer() { throw new Error("not used"); },
  });
  transport.methodResults.set("turn/start", { turn: { id: "turn-helper" } });

  await adapter.sendMessage("restored-eyes", {
    requestId: "restored-eyes-send",
    content: "Inspect this image.",
    metadata: { internalPurpose: "vision_proxy" },
  });
  await adapter.sendMessage("restored-ears", {
    requestId: "restored-ears-send",
    content: "Transcribe this recording.",
    metadata: { internalPurpose: "ears" },
  });

  const helperCalls = transport.sent.filter((message) => typeof message === "object" && message !== null
    && ["thread/resume", "turn/start"].includes(String((message as Record<string, unknown>).method))) as Record<string, unknown>[];
  assert.deepEqual(helperCalls.map((call) => call.method), ["turn/start", "turn/start"]);
  assert.equal(helperCalls.some((call) => {
    const params = call.params as Record<string, unknown>;
    return "dynamicTools" in params;
  }), false);
  await adapter.dispose();
});

test("Codex EYES applies native tool isolation without changing ordinary threads", async (t) => {
  const { adapter, transport } = await adapterWithPeer({ isolatedVisionRuntime: true });
  t.after(() => adapter.dispose());
  transport.methodResults.set("config/read", { config: { mcp_servers: { test: { command: "never-start", enabled: true } } } });
  transport.methodResponses.set("thread/start", [
    { result: { thread: { id: "isolated", status: { type: "idle" }, cwd: "C:\\workspace" } } },
    { result: { thread: { id: "ordinary", status: { type: "idle" }, cwd: "C:\\workspace" } } },
  ]);
  await adapter.createSession({ workingDirectory: "C:\\workspace", metadata: { internalPurpose: "vision_proxy" } });
  await adapter.createSession({ workingDirectory: "C:\\workspace" });
  const starts = transport.sent.filter((m: any) => m.method === "thread/start") as Array<{ params: Record<string, any> }>;
  assert.deepEqual(starts[0]?.params.config.mcp_servers, { test: { enabled: false, required: false } });
  assert.equal(starts[0]?.params.config.features.shell_tool, false);
  assert.deepEqual(starts[0]?.params.dynamicTools, []);
  assert.equal(starts[1]?.params.config, undefined);
  assert.equal(starts[1]?.params.baseInstructions, undefined);
  await adapter.releaseSession("ordinary");
  await adapter.releaseSession("isolated");
  const releases = transport.sent.filter((m: any) => m.method === "thread/unsubscribe") as Array<{ params: unknown }>;
  assert.deepEqual(releases.map(m => m.params), [{ threadId: "isolated" }]);
});

for (const crashHelper of [false, true]) test(`Codex EYES ${crashHelper ? "runtime failure remains helper-scoped" : "uses a separate stripped runtime and closes only that runtime on release"}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eyes-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.json");
  await writeFile(sourcePath, JSON.stringify({ models: [{ slug: "exact-vision-model", tool_mode: "code_mode_only" }] }));
  const normal = new FakeTransport();
  const helper = new FakeTransport();
  normal.methodResults.set("config/read", { config: { model_catalog_json: sourcePath } });
  helper.methodResults.set("config/read", { config: { mcp_servers: { inherited: { enabled: true } } } });
  helper.methodResults.set("thread/start", { thread: { id: "eyes-child", status: { type: "idle" }, cwd: directory } });
  helper.methodResults.set("thread/read", { thread: { id: "eyes-child", status: { type: "idle" }, turns: [], cwd: directory } });
  helper.methodResults.set("turn/start", { turn: { id: "eyes-child-turn" } });
  let catalogPath: string | undefined;
  const adapter = new CodexAdapter({
    hostId: "host_1", command: "fake-codex.exe",
    transportFactory: (args) => {
      const override = args?.find(arg => arg.startsWith("model_catalog_json="));
      if (!override) return normal;
      catalogPath = JSON.parse(override.slice("model_catalog_json=".length)) as string;
      return helper;
    },
  });
  t.after(() => adapter.dispose());
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.getAuthStatus();
  normal.push({ method: "thread/status/changed", params: { threadId: "normal-thread", status: { type: "idle" } } });
  await delay(5);
  const session = await adapter.createSession({ workingDirectory: directory, modelId: "exact-vision-model", metadata: { internalPurpose: "vision_proxy" } });
  assert.ok(catalogPath);
  assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).models[0].tool_mode, null);
  assert.equal((await adapter.getSession(session.providerSessionId)).providerSessionId, "eyes-child");
  assert.deepEqual(await adapter.getMessages(session.providerSessionId), []);
  await adapter.sendMessage(session.providerSessionId, { requestId: "image", content: "Inspect", metadata: { internalPurpose: "vision_proxy" } });
  assert.equal(normal.sent.some((m: any) => m.method === "turn/start"), false);
  assert.equal(helper.sent.some((m: any) => m.method === "turn/start"), true);
  helper.push({ method: "turn/completed", params: { threadId: "eyes-child", turn: { id: "eyes-child-turn", status: "completed" } } });
  await delay(5);
  assert.equal(events.some(event => event.providerSessionId === "normal-thread"), true);
  assert.equal(events.some(event => event.type === "agent.completed" && event.providerSessionId === "eyes-child"), true);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length, "child events must receive unique provider-wide IDs");
  if (crashHelper) {
    helper.crash(new Error("private runtime lost"));
    await delay(5);
    assert.equal(events.some(event => event.type === "provider.disconnected"), false);
    assert.equal(events.some(event => event.type === "agent.error" && event.providerSessionId === "eyes-child"), true);
    await assert.rejects(adapter.getSession(session.providerSessionId), { code: "SESSION_NOT_FOUND" });
  }
  await adapter.releaseSession(session.providerSessionId);
  assert.equal(helper.closeCalls, crashHelper ? 0 : 1);
  assert.equal(normal.closeCalls, 0);
  await assert.rejects(readFile(catalogPath), { code: "ENOENT" });
});

test("Codex expired ephemeral EYES sessions are not resumed after idle shutdown", async (t) => {
  const transport = new FakeTransport();
  transport.methodResults.set("config/read", { config: {} });
  transport.methodResults.set("thread/start", { thread: { id: "idle-eyes", status: { type: "idle" } } });
  let launches = 0;
  const adapter = new CodexAdapter({
    hostId: "host-eyes-idle", isolatedVisionRuntime: true, idleReleaseMs: 5,
    transportFactory: () => { launches += 1; return transport; },
  });
  t.after(() => adapter.dispose());
  await adapter.createSession({ workingDirectory: "C:\\workspace", ephemeral: true, metadata: { internalPurpose: "vision_proxy" } });
  await delay(20);
  assert.equal(transport.closeCalls, 1);
  await assert.rejects(adapter.getSession("idle-eyes"), { code: "SESSION_NOT_FOUND" });
  assert.equal(launches, 1);
  assert.equal(transport.sent.some((m: any) => m.method === "thread/resume"), false);
});

test("Codex ephemeral EYES retains its streamed observation without unsupported history reads", async (t) => {
  const { adapter, transport } = await adapterWithPeer({ isolatedVisionRuntime: true });
  t.after(() => adapter.dispose());
  transport.methodResults.set("config/read", { config: {} });
  transport.methodResults.set("thread/start", { thread: { id: "eyes-stream", status: { type: "idle" } } });
  await adapter.createSession({ workingDirectory: "C:\\workspace", ephemeral: true, metadata: { internalPurpose: "vision_proxy" } });
  assert.deepEqual(await adapter.getMessages("eyes-stream"), []);
  for (const turn of ["first", "second"]) {
    transport.push({ method: "turn/started", params: { threadId: "eyes-stream", turn: { id: turn } } });
    transport.push({ method: "item/completed", params: { threadId: "eyes-stream", turnId: turn, item: { id: `answer-${turn}`, type: "agentMessage", text: `${turn} observation` } } });
    await delay(5);
    const messages = await adapter.getMessages("eyes-stream");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.nativeMetadata.turnId, turn);
    assert.deepEqual(messages[0]?.parts, [{ type: "text", text: `${turn} observation` }]);
    transport.push({ method: "turn/completed", params: { threadId: "eyes-stream", turn: { id: turn, status: "completed" } } });
    await delay(5);
  }
  assert.equal(transport.sent.some((m: any) => m.method === "thread/read"), false);
});

test("Codex EYES does not start a helper if its inherited configuration is unknown", async (t) => {
  const { adapter, transport } = await adapterWithPeer();
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.createSession({ workingDirectory: "C:\\workspace", metadata: { internalPurpose: "vision_proxy" } }), /configuration needed to isolate EYES/);
  assert.equal(transport.sent.some((m: any) => m.method === "thread/start"), false);
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

test("Codex resumes an unloaded persisted thread and retries fork exactly once", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/fork", [
    { error: { code: -32600, message: "Thread thread-source is not loaded" } },
    { result: {
      thread: {
        id: "thread-forked-after-resume",
        sessionId: "thread-forked-after-resume",
        forkedFromId: "thread-source",
        preview: "Copied after resume",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        cwd: "C:\\workspace",
        cliVersion: "test",
        turns: [],
      },
    } },
  ]);
  transport.methodResults.set("thread/resume", { thread: { id: "thread-source" } });

  const session = await adapter.branchSession("thread-source");
  const calls = transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/fork", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(calls.map((call) => call.method), ["thread/fork", "thread/resume", "thread/fork"]);
  assert.deepEqual(calls[0]?.params, { threadId: "thread-source" });
  assert.deepEqual(calls[2]?.params, calls[0]?.params, "the one retry must fork the same source thread");
  assert.equal(calls.filter((call) => call.method === "thread/fork").length, 2, "fork must run only initially and once after resume");
  assert.equal(session.providerSessionId, "thread-forked-after-resume");
  await adapter.dispose();
});

test("Codex branch preserves unrelated errors and never retries after a mismatched resume", async () => {
  const unrelated = await adapterWithPeer();
  unrelated.transport.methodResponses.set("thread/fork", [
    { error: { code: -32603, message: "Fork denied by workspace policy" } },
  ]);
  await assert.rejects(
    unrelated.adapter.branchSession("thread-source"),
    /Fork denied by workspace policy/iu,
  );
  const unrelatedCalls = unrelated.transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/fork", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(unrelatedCalls.map((call) => call.method), ["thread/fork"]);
  await unrelated.adapter.dispose();

  const mismatched = await adapterWithPeer();
  mismatched.transport.methodResponses.set("thread/fork", [
    { error: { code: -32600, message: "thread not found: thread-source" } },
  ]);
  mismatched.transport.methodResults.set("thread/resume", { thread: { id: "different-thread" } });
  await assert.rejects(
    mismatched.adapter.branchSession("thread-source"),
    /Codex resumed a different thread ID/iu,
  );
  const mismatchedCalls = mismatched.transport.sent.filter((message) =>
    typeof message === "object" && message !== null
    && ["thread/fork", "thread/resume"].includes(String((message as Record<string, unknown>).method))
  ) as Record<string, unknown>[];
  assert.deepEqual(mismatchedCalls.map((call) => call.method), ["thread/fork", "thread/resume"]);
  await mismatched.adapter.dispose();
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
    { modelProviders: [], useStateDbOnly: true, archived: false },
    { parentThreadId: "parent-thread", modelProviders: [], useStateDbOnly: true, archived: false },
  ]);
  await adapter.dispose();
});

test("Codex keeps tasks from a previous model backend discoverable on every catalogue page", async (t) => {
  const transport = new FakeTransport();
  const send = transport.send.bind(transport);
  transport.send = async (message: unknown) => {
    const request = message as { method?: string; params?: { modelProviders?: string[]; cursor?: string } };
    if (request.method === "thread/list") {
      const includeAll = Array.isArray(request.params?.modelProviders) && request.params.modelProviders.length === 0;
      const secondPage = request.params?.cursor === "next-page";
      const thread = {
        id: secondPage ? "previous-backend-task" : "current-backend-task",
        modelProvider: secondPage ? "previous-backend" : "openai",
        name: secondPage ? "Continue button fix" : "Current task",
        cwd: "/work/project", createdAt: 1, updatedAt: 2,
      };
      transport.methodResults.set("thread/list", {
        data: secondPage && !includeAll ? [] : [thread],
        nextCursor: !secondPage && includeAll ? "next-page" : null,
      });
    }
    await send(message);
  };
  const adapter = new CodexAdapter({ hostId: "host", transportFactory: () => transport });
  t.after(() => adapter.dispose());
  const first = await adapter.listSessions({ limit: 1, sortKey: "updated_at" });
  assert.equal(first.nextCursor, "next-page");
  const second = await adapter.listSessions({ limit: 1, sortKey: "updated_at", cursor: first.nextCursor });
  assert.deepEqual([...first.sessions, ...second.sessions].map(session => session.providerSessionId), ["current-backend-task", "previous-backend-task"]);
  assert.equal(second.sessions[0]?.title, "Continue button fix");
  assert.equal(second.nextCursor, null);
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
  assert.equal(await adapter.getMessages("desktop-thread"), messages,
    "an unchanged older-page load must reuse both rollout parsing and remote-message normalization");
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read"), false,
  "local rollout history must not wait for App Server to rebuild the complete thread");

  await appendFile(rollout, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-current", reasoning_effort: "high" } })}\n`, "utf8");
  const deadline = Date.now() + 500;
  while (events.every((event) => event.type !== "session.updated") && Date.now() < deadline) await delay(10);
  const update = events.find((event) => event.type === "session.updated");
  assert.equal(update?.providerSessionId, "desktop-thread");
  assert.deepEqual(update?.payload, { modelId: "gpt-current", reasoningEffort: "high" });
  assert.equal(update?.nativeEvent, undefined);
});

test("Codex pages older rollout history twice without starting a complete history read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-native-older-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, Array.from({ length: 18 }, (_, index) => `${JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 25, 12, 0, index)).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      id: `message-${index}`,
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: `Answer ${index} ${"x".repeat(180)}` }],
    },
  })}\n`).join(""), "utf8");

  class CountingCodexAdapter extends CodexAdapter {
    public fullHistoryReads = 0;
    public override async getMessages(providerSessionId: string) {
      this.fullHistoryReads += 1;
      return await super.getMessages(providerSessionId);
    }
  }

  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: "paged-thread",
      sessionId: "paged-thread",
      preview: "Paged thread",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    }],
    nextCursor: null,
  });
  const adapter = new CountingCodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: { codexHome: directory, historyBytes: 900 },
  });
  t.after(() => adapter.dispose());
  await adapter.listSessions();

  const recent = await adapter.getRecentMessages("paged-thread");
  assert.ok(recent.messages.length > 0);
  assert.equal(recent.complete, false);
  assert.ok(recent.olderCursor);
  const firstOlder = await adapter.getOlderMessages("paged-thread", recent.olderCursor);
  assert.ok(firstOlder.messages.length > 0);
  assert.equal(firstOlder.pageOnly, true);
  assert.equal(firstOlder.complete, false);
  assert.ok(firstOlder.olderCursor);
  assert.notEqual(firstOlder.olderCursor, recent.olderCursor);
  const secondOlder = await adapter.getOlderMessages("paged-thread", firstOlder.olderCursor);
  assert.ok(secondOlder.messages.length > 0);
  assert.equal(secondOlder.pageOnly, true);
  assert.equal(secondOlder.complete, false);
  assert.ok(secondOlder.olderCursor);
  assert.notEqual(secondOlder.olderCursor, firstOlder.olderCursor);

  const messageOrdinal = (id: string | undefined) => Number.parseInt(id?.slice("message-".length) ?? "NaN", 10);
  assert.ok(firstOlder.messages.length < 20, "an older response must remain one byte page plus bounded line overlap");
  assert.ok(secondOlder.messages.length < 20, "successive responses must not reconstruct cumulative history");
  assert.ok(messageOrdinal(firstOlder.messages[0]?.providerMessageId)
    < messageOrdinal(recent.messages[0]?.providerMessageId));
  assert.ok(messageOrdinal(secondOlder.messages[0]?.providerMessageId)
    < messageOrdinal(firstOlder.messages[0]?.providerMessageId));
  assert.equal(new Set(firstOlder.messages.map((message) => message.id)).size, firstOlder.messages.length);
  assert.equal(new Set(secondOlder.messages.map((message) => message.id)).size, secondOlder.messages.length);
  assert.equal(adapter.fullHistoryReads, 0, "progressive older pages must not call getMessages/allMessages");
  assert.equal(transport.sent.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    const params = record.params as Record<string, unknown> | undefined;
    return record.method === "thread/read" && params?.includeTurns === true;
  }), false, "progressive older pages must not rebuild the thread through App Server");

  const complete = await adapter.getMessages("paged-thread");
  assert.equal(complete.length, 18, "explicit full-history consumers keep the complete rollout transcript");
  assert.equal(adapter.fullHistoryReads, 1);
});

test("Codex reads an empty local rollout without requesting unsupported native turns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-codex-empty-side-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "empty-thread", cwd: directory } })}\n`, "utf8");
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{ id: "empty-thread", preview: "Empty task", cwd: directory, path: rollout, createdAt: 1, updatedAt: 1, status: { type: "idle" } }],
    nextCursor: null,
  });
  transport.methodResponses.set("thread/read", [{ error: { code: -32603, message: "list_turns is not supported yet" } }]);
  const adapter = new CodexAdapter({ hostId: "empty-codex", transportFactory: () => transport, localActivity: { codexHome: directory } });
  t.after(() => adapter.dispose());
  await adapter.listSessions();
  assert.deepEqual(await adapter.getMessages("empty-thread"), []);
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read"), false);
});

test("Codex hydrates a persisted task path before considering complete App Server history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-persisted-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({
    timestamp: "2026-08-26T02:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id: "persisted-answer",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Bounded persisted answer" }],
    },
  })}\n`, "utf8");

  const transport = new FakeTransport();
  transport.methodResults.set("thread/read", {
    thread: {
      id: "persisted-thread",
      sessionId: "persisted-thread",
      preview: "Persisted thread",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      status: { type: "idle" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    },
  });
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: { codexHome: directory, historyBytes: 1_024 },
  });
  t.after(() => adapter.dispose());

  const recent = await adapter.getRecentMessages("persisted-thread");

  assert.equal(recent.messages.at(-1)?.providerMessageId, "persisted-answer");
  const threadReads = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read") as Array<Record<string, unknown>>;
  assert.equal(threadReads.length, 1, "path hydration needs one metadata-only thread read");
  assert.equal((threadReads[0]?.params as Record<string, unknown> | undefined)?.includeTurns, false);
});

test("Codex history falls back to App Server when no local rollout messages exist", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/read", {
    thread: {
      id: "app-server-only",
      createdAt: 1,
      turns: [{
        createdAt: 2,
        items: [{ id: "answer-1", type: "agentMessage", content: [{ type: "output_text", text: "Fallback answer" }] }],
      }],
    },
  });

  const messages = await adapter.getMessages("app-server-only");
  const fallbackPart = messages.at(-1)?.parts[0];

  assert.equal(fallbackPart?.type, "text");
  assert.equal(fallbackPart?.type === "text" ? fallbackPart.text : undefined, "Fallback answer");
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read"), true);
  await adapter.dispose();
});

test("Codex includes an externally active locked thread without parsing its transcript during listing", async (t) => {
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
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, localActivity: { codexHome: directory, isLockHeld: fileExists } });
  t.after(() => adapter.dispose());

  const page = await adapter.listSessions();
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0]?.providerSessionId, activeId);
  assert.equal(page.sessions[0]?.state, "working");
  assert.equal(page.sessions[0]?.externalWriter, true);
  assert.equal(page.sessions[0]?.preview, "Active external task");
  assert.notEqual(page.sessions[0]?.preview, "Also, this chat itself is not showing up in that session list.");
});

test("Codex discovers a newly started external task without another catalogue read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-new-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  await mkdir(lockDirectory, { recursive: true });
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "new-writer.jsonl");
  const thread = {
    id: threadId,
    sessionId: threadId,
    preview: "New external task",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "notLoaded" },
    path: rollout,
    cwd: directory,
    cliVersion: "0.147.0",
  };
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", { data: [], nextCursor: null });
  transport.methodResults.set("thread/read", { thread });
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: { codexHome: directory, pollIntervalMs: 5, isLockHeld: fileExists },
  });
  t.after(() => adapter.dispose());
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  assert.deepEqual((await adapter.listSessions()).sessions, []);

  await writeFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8");
  await writeFile(join(lockDirectory, `${threadId}.lock`), "");
  const deadline = Date.now() + 500;
  while (!events.some((event) => event.type === "session.updated" && event.providerSessionId === threadId) && Date.now() < deadline) {
    await delay(5);
  }

  assert.equal(events.some((event) => event.type === "session.updated"
    && event.providerSessionId === threadId
    && event.payload.state === "working"
    && event.payload.activityDiscovered === true), true);
  const listCalls = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/list");
  const reads = transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "thread/read") as Array<Record<string, unknown>>;
  assert.equal(listCalls.length, 1, "writer discovery must not trigger another provider catalogue read");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]?.params, { threadId, includeTurns: false });
});

test("Codex never treats a retained writer lock with a terminal rollout as working", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-terminal-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  await mkdir(lockDirectory, { recursive: true });
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee857";
  const rollout = join(directory, "terminal-writer.jsonl");
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", { data: [], nextCursor: null });
  transport.methodResults.set("thread/read", {
    thread: {
      id: threadId,
      sessionId: threadId,
      preview: "Already finished external task",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "notLoaded" },
      path: rollout,
      cwd: directory,
      cliVersion: "0.147.0",
    },
  });
  const adapter = new CodexAdapter({
    hostId: "host_1",
    transportFactory: () => transport,
    localActivity: { codexHome: directory, pollIntervalMs: 5, isLockHeld: fileExists },
  });
  t.after(() => adapter.dispose());
  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.listSessions();

  await writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n"), "utf8");
  await writeFile(join(lockDirectory, `${threadId}.lock`), "");
  const deadline = Date.now() + 500;
  while (!events.some((event) => event.type === "session.updated" && event.providerSessionId === threadId) && Date.now() < deadline) {
    await delay(5);
  }

  const discovered = events.filter((event) => event.type === "session.updated" && event.providerSessionId === threadId);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.payload.state, "idle");
  assert.equal(discovered.some((event) => event.payload.state === "working"), false);
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
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, localActivity: { codexHome: directory, isLockHeld: fileExists } });
  t.after(() => adapter.dispose());

  const locked = (await adapter.listSessions()).sessions[0];
  assert.equal(locked?.state, "idle", "writer ownership must not make an idle task look busy");
  assert.equal(locked?.externalWriter, true);

  await rm(lockPath);
  const unlocked = (await adapter.listSessions()).sessions[0];
  assert.equal(unlocked?.state, "idle");
  assert.equal(unlocked?.externalWriter, undefined);

  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({ method: "thread/status/changed", params: { threadId, status: { type: "active" } } });
  await delay(5);
  transport.push({ method: "thread/status/changed", params: { threadId, status: { type: "notLoaded" } } });
  await delay(5);
  assert.deepEqual(events.filter((event) => event.type === "session.status_changed").map((event) => event.payload.state), ["working", "idle"]);
});

test("an external started rollout stays working when App Server still reports not loaded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-started-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const rollout = join(directory, "rollout.jsonl");
  await mkdir(join(directory, "thread-writer-locks"), { recursive: true });
  const lockPath = join(directory, "thread-writer-locks", `${threadId}.lock`);
  await writeFile(lockPath, "");
  await writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ].join("\n"), "utf8");
  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: threadId,
      sessionId: threadId,
      preview: "Battlefield 6 Portal",
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
  const adapter = new CodexAdapter({ hostId: "host_1", transportFactory: () => transport, localActivity: { codexHome: directory, isLockHeld: fileExists } });
  t.after(() => adapter.dispose());

  const session = (await adapter.listSessions()).sessions[0];
  assert.equal(session?.externalWriter, true);
  assert.equal(session?.state, "working");
  assert.equal(adapter.hasActiveTurn(threadId), true);

  await rm(lockPath);
  assert.equal((await adapter.listSessions()).sessions[0]?.state, "idle");
  assert.equal(adapter.hasActiveTurn(threadId), false);
  await writeFile(lockPath, "");
  assert.equal((await adapter.listSessions()).sessions[0]?.state, "idle",
    "the same stale lock must not revive a retired rollout without new bytes");
  assert.equal(adapter.hasActiveTurn(threadId), false);

  await appendFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8");
  assert.equal((await adapter.listSessions()).sessions[0]?.state, "working");
  assert.equal(adapter.hasActiveTurn(threadId), true, "new rollout evidence may establish a new external turn");

  const events: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { events.push(event); });
  transport.push({ method: "thread/status/changed", params: { threadId, status: { type: "notLoaded" } } });
  await delay(5);
  assert.equal(events.some((event) => event.type === "session.status_changed" && event.payload.state !== "working"), false,
    "a stale App Server status cannot hide an active external rollout");
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

test("Codex cached working status is not active-turn authority without a real turn id", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.push({ method: "thread/status/changed", params: { threadId: "status-only", status: { type: "active" } } });
  await delay(25);
  assert.equal(adapter.hasActiveTurn("status-only"), false,
    "a retained status label must not keep exposing live-only actions after its turn disappeared");

  transport.push({ method: "turn/started", params: { threadId: "status-only", turn: { id: "real-turn" } } });
  await delay(25);
  assert.equal(adapter.hasActiveTurn("status-only"), true);

  transport.push({ method: "turn/completed", params: { threadId: "status-only", turn: { id: "real-turn", status: "completed" } } });
  await delay(25);
  assert.equal(adapter.hasActiveTurn("status-only"), false);
  await adapter.dispose();
});

test("an unexpected App Server exit clears active task state instead of leaving a phantom turn", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({ method: "turn/started", params: { threadId: "crashed-turn", turn: { id: "turn-before-crash" } } });
  transport.push({ method: "thread/status/changed", params: { threadId: "crashed-turn", status: { type: "active" } } });
  await delay(25);
  assert.equal(adapter.hasActiveTurn("crashed-turn"), true);

  transport.crash(new Error("Codex App Server exited unexpectedly"));
  await delay(25);

  assert.equal(adapter.hasActiveTurn("crashed-turn"), false);
  assert.deepEqual(events
    .filter((event) => event.type === "session.status_changed" && event.providerSessionId === "crashed-turn")
    .map((event) => event.payload.state), ["working", "unknown"]);
  assert.equal(events.some((event) => event.type === "provider.disconnected"), true);
  await adapter.dispose();
});

test("Codex disconnect retires native questions and forms without a locally owned turn", async (t) => {
  const { adapter, transport, events } = await adapterWithPeer();
  t.after(() => adapter.dispose());
  transport.push({ id: "external-question", method: "item/tool/requestUserInput", params: {
    threadId: "external-task", turnId: "external-turn", questions: [{ id: "choice", header: "Storage", question: "Where?", options: [{ label: "Local", description: "This device" }] }],
  } });
  transport.push({ id: "external-form", method: "mcpServer/elicitation/request", params: {
    threadId: "form-task", serverName: "Workspace", mode: "form", message: "Choose a name", requestedSchema: { type: "object", properties: { name: { type: "string" } } },
  } });
  await delay(15);
  assert.equal(events.filter((event) => event.type === "user_input.requested").length, 2);
  transport.crash(new Error("Native connection closed"));
  await delay(15);
  assert.deepEqual(events.filter((event) => event.type === "user_input.resolved").map((event) => event.payload.providerRequestId).sort(), ["external-form", "external-question"]);
  assert.equal(events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted"), false);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "external-question", answers: { choice: ["Local"] } }), /stale/);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "external-form", answers: { action: "cancel" } }), /stale/);
});

test("a stale completion cannot retire a newer owned Codex turn", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({ method: "turn/started", params: { threadId: "ordered-turns", turn: { id: "turn-a" } } });
  transport.push({ method: "turn/started", params: { threadId: "ordered-turns", turn: { id: "turn-b" } } });
  transport.push({ method: "turn/completed", params: { threadId: "ordered-turns", turn: { id: "turn-a", status: "completed" } } });
  transport.push({ method: "thread/status/changed", params: { threadId: "ordered-turns", status: { type: "idle" } } });
  await delay(25);

  assert.equal(adapter.ownsActiveTurn("ordered-turns"), true);
  assert.equal(events.some((event) => event.type === "agent.completed" && event.payload.turnId === "turn-a"), false);
  assert.equal(events.some((event) => event.type === "session.status_changed" && event.payload.state === "idle"), false);

  transport.push({ method: "turn/completed", params: { threadId: "ordered-turns", turn: { id: "turn-b", status: "completed" } } });
  await delay(25);
  assert.equal(adapter.ownsActiveTurn("ordered-turns"), false);
  assert.equal(events.some((event) => event.type === "agent.completed" && event.payload.turnId === "turn-b"), true);
  await adapter.dispose();
});

test("a delayed status reconciliation cannot land after a later completion", async () => {
  const transport = new FakeTransport();
  const events: ProviderEvent[] = [];
  let releaseLockProbe: ((held: boolean) => void) | undefined;
  let lockProbeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { lockProbeStarted = resolve; });
  const adapter = new CodexAdapter({
    hostId: "host_ordered_status",
    transportFactory: () => transport,
    localActivity: {
      isLockHeld: async () => await new Promise<boolean>((resolve) => {
        releaseLockProbe = resolve;
        lockProbeStarted?.();
      }),
    },
  });
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.getAuthStatus();
  transport.push({ method: "thread/status/changed", params: { threadId: "ordered-status", status: { type: "active" } } });
  await started;
  transport.push({ method: "turn/completed", params: { threadId: "ordered-status", turn: { id: "turn-finished", status: "completed" } } });
  await delay(5);
  assert.equal(events.some((event) => event.type === "agent.completed"), false, "later lifecycle notifications wait for earlier reconciliation");

  releaseLockProbe?.(false);
  await delay(25);
  assert.deepEqual(events
    .filter((event) => event.type === "session.status_changed" || event.type === "agent.completed")
    .map((event) => event.type), ["session.status_changed", "agent.completed"]);
  await adapter.dispose();
});

test("an unacknowledged steer is quarantined as delivery-unknown", async () => {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter({ hostId: "host_ambiguous_steer", requestTimeoutMs: 20, transportFactory: () => transport });
  await adapter.getAuthStatus();
  transport.push({ method: "turn/started", params: { threadId: "ambiguous-steer", turn: { id: "active-turn" } } });
  await delay(10);
  transport.blockedMethods.add("turn/steer");

  await assert.rejects(() => adapter.steerMessage("ambiguous-steer", {
    requestId: "ambiguous-steer-request",
    content: "Apply this once",
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DELIVERY_UNKNOWN");
    assert.equal((error as { retryable?: boolean }).retryable, false);
    return true;
  });
  assert.equal(transport.sent.filter((message) => typeof message === "object" && message !== null
    && (message as Record<string, unknown>).method === "turn/steer").length, 1);
  await adapter.dispose();
});

test("Codex forwards non-empty native thread names immediately", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({ method: "thread/name/updated", params: { threadId: "t1", threadName: "  Harness generated title  " } });
  transport.push({ method: "thread/name/updated", params: { threadId: "t1", threadName: "   " } });
  transport.push({ method: "thread/name/updated", params: { threadId: "t1" } });
  await delay(25);

  assert.deepEqual(events.filter((event) => event.type === "session.updated").map((event) => event.payload), [
    { title: "Harness generated title" },
  ]);
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

test("Codex live assistant notifications hide annotation directives without joining streamed words", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  transport.push({
    method: "item/agentMessage/delta",
    params: {
      threadId: "t1",
      turnId: "tu1",
      itemId: "assistant-annotation",
      delta: ' :codex-annotation{index="4"}continued',
    },
  });
  transport.push({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "tu1",
      item: {
        id: "assistant-annotation",
        type: "agentMessage",
        content: [{
          type: "output_text",
          text: '\n  :codex-annotation{index="4"}Final response.\n\n  Second paragraph.',
        }],
      },
    },
  });
  await delay(25);

  const delta = events.find((event) => event.type === "message.delta" && event.payload.itemId === "assistant-annotation");
  assert.equal(delta?.payload.text, " continued");
  const completed = events.find((event) => event.type === "message.completed"
    && event.payload.text === "Final response.\n\n  Second paragraph.");
  assert.equal(completed?.payload.text, "Final response.\n\n  Second paragraph.");
  assert.doesNotMatch(String(completed?.payload.text), /codex-annotation/u);
  await adapter.dispose();
});

test("Codex uses the documented native goal RPCs without starting a turn", async () => {
  const { adapter, transport } = await adapterWithPeer();
  const native = { threadId: "t1", objective: "Ship the reliable goal UI", status: "active", tokenBudget: 12000, tokensUsed: 400, timeUsedSeconds: 15, createdAt: 1_777_000_000, updatedAt: 1_777_000_010 };
  transport.methodResults.set("thread/goal/get", { goal: native });
  transport.methodResults.set("thread/goal/set", { goal: { ...native, status: "paused" } });
  transport.methodResults.set("thread/goal/clear", { cleared: true });

  assert.equal((await adapter.getGoal("t1"))?.objective, native.objective);
  assert.equal((await adapter.setGoal("t1", { status: "paused" }))?.status, "paused");
  assert.equal(await adapter.clearGoal("t1"), true);
  const calls = transport.sent.filter((message) => typeof message === "object" && message !== null && String((message as Record<string, unknown>).method).startsWith("thread/goal")) as Array<Record<string, unknown>>;
  assert.deepEqual(calls.map(({ method, params }) => ({ method, params })), [
    { method: "thread/goal/get", params: { threadId: "t1" } },
    { method: "thread/goal/set", params: { threadId: "t1", status: "paused" } },
    { method: "thread/goal/clear", params: { threadId: "t1" } },
  ]);
  assert.equal(transport.sent.some((message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "turn/start"), false);
  await adapter.dispose();
});

test("Codex forwards native goal updates and clears without changing session state", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  const goal = { threadId: "t1", objective: "Keep the task goal visible", status: "blocked", tokenBudget: null, tokensUsed: 90, timeUsedSeconds: 6, createdAt: 1_777_000_000, updatedAt: 1_777_000_020 };
  transport.push({ method: "thread/goal/updated", params: { threadId: "t1", turnId: null, goal } });
  transport.push({ method: "thread/goal/cleared", params: { threadId: "t1" } });
  await delay(5);
  assert.deepEqual(events.map((event) => event.type), ["session.goal_updated", "session.goal_cleared"]);
  assert.equal((events[0]?.payload.goal as Record<string, unknown>).status, "blocked");
  assert.equal(events.some((event) => event.type === "session.status_changed"), false);
  await adapter.dispose();
});

test("Codex falls back only when the installed App Server lacks goal methods", async () => {
  const { adapter, transport } = await adapterWithPeer();
  for (const method of ["thread/goal/get", "thread/goal/set", "thread/goal/clear"]) {
    transport.methodResponses.set(method, [{ error: { code: -32601, message: "Method not found" } }]);
  }
  assert.equal(await adapter.getGoal("t1"), undefined);
  assert.equal(await adapter.setGoal("t1", { objective: "Fallback goal" }), undefined);
  assert.equal(await adapter.clearGoal("t1"), undefined);
  await adapter.dispose();
});

test("Codex rejects malformed goal responses instead of treating them as unsupported", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResults.set("thread/goal/get", { goal: { objective: "", status: "active" } });
  await assert.rejects(adapter.getGoal("t1"), /invalid thread\/goal\/get response/);
  transport.methodResults.set("thread/goal/set", { goal: null });
  await assert.rejects(adapter.setGoal("t1", { objective: "A valid objective" }), /invalid thread\/goal\/set response/);
  transport.methodResults.set("thread/goal/clear", {});
  await assert.rejects(adapter.clearGoal("t1"), /invalid thread\/goal\/clear response/);
  await adapter.dispose();
});

test("Codex validates native goal identity, bounds, and ordering fields", async () => {
  const { adapter, transport } = await adapterWithPeer();
  const valid = {
    threadId: "t1",
    objective: "A valid native goal",
    status: "active",
    tokenBudget: 12_000,
    tokensUsed: 400,
    timeUsedSeconds: 15,
    createdAt: 1_777_000_000,
    updatedAt: 1_777_000_010,
    revision: 2,
  } as const;
  const malformed: readonly [string, unknown][] = [
    ["threadId", "other-thread"],
    ["objective", "   "],
    ["objective", "x".repeat(4_001)],
    ["status", "running"],
    ["tokenBudget", 0],
    ["tokenBudget", 1.5],
    ["tokensUsed", -1],
    ["tokensUsed", 1.5],
    ["timeUsedSeconds", -1],
    ["timeUsedSeconds", 1.5],
    ["createdAt", 0],
    ["createdAt", "2026-08-23T00:00:00.000Z"],
    ["updatedAt", Number.POSITIVE_INFINITY],
    ["updatedAt", "not-a-timestamp"],
    ["revision", -1],
    ["revision", 1.5],
    ["revision", "2"],
  ];

  for (const [field, value] of malformed) {
    transport.methodResults.set("thread/goal/get", { goal: { ...valid, [field]: value } });
    await assert.rejects(adapter.getGoal("t1"), /invalid thread\/goal\/get response/, field);
  }

  transport.methodResults.set("thread/goal/get", { threadId: "other-thread", goal: valid });
  await assert.rejects(adapter.getGoal("t1"), /invalid thread\/goal\/get response/);
  await adapter.dispose();
});

test("Codex rejects native goal events that are not tied to their goal thread", async () => {
  const { adapter, transport, events } = await adapterWithPeer();
  const valid = {
    threadId: "t1",
    objective: "A valid native goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1_777_000_000,
    updatedAt: 1_777_000_010,
  } as const;

  transport.push({ method: "thread/goal/updated", params: { threadId: "t1", goal: { ...valid, threadId: "other-thread" } } });
  transport.push({ method: "thread/goal/cleared", params: { threadId: "t1", revision: "not-a-revision" } });
  await delay(25);
  assert.equal(events.some((event) => event.type === "session.goal_updated" || event.type === "session.goal_cleared"), false);

  transport.push({ method: "thread/goal/updated", params: { threadId: "t1", goal: valid } });
  await delay(25);
  assert.equal(events.filter((event) => event.type === "session.goal_updated").length, 1);
  await adapter.dispose();
});

test("Codex does not fall back for non-method-not-found goal errors", async () => {
  const { adapter, transport } = await adapterWithPeer();
  transport.methodResponses.set("thread/goal/get", [{ error: { code: -32000, message: "goal storage failed" } }]);
  await assert.rejects(adapter.getGoal("t1"), /goal storage failed/);
  transport.methodResponses.set("thread/goal/set", [{ error: { code: -32602, message: "invalid params" } }]);
  await assert.rejects(adapter.setGoal("t1", { objective: "A valid objective" }), /invalid params/);
  transport.methodResponses.set("thread/goal/clear", [{ error: { code: -32001, message: "permission denied" } }]);
  await assert.rejects(adapter.clearGoal("t1"), /permission denied/);
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

test("foreign rollout image messages request a sanitized canonical history refresh", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-adapter-image-signal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "turn_context" })}\n`, "utf8");

  const transport = new FakeTransport();
  transport.methodResults.set("thread/list", {
    data: [{
      id: "foreign-image-thread",
      sessionId: "foreign-image-thread",
      preview: "Foreign image thread",
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
  await adapter.listSessions();
  await delay(25);

  const privatePath = "C:\\Users\\person\\AppData\\Local\\Temp\\screen-capture.png";
  const imageDataUri = `data:image/png;base64,${Buffer.alloc(18_000, 0xa5).toString("base64")}`;
  await appendFile(rollout, `${JSON.stringify({
    timestamp: "2026-09-02T11:22:33.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id: "user-with-live-image",
      role: "user",
      content: [
        { type: "input_text", text: "The attached image should be visible." },
        { type: "input_text", text: `<image name=[Image #1] path="${privatePath}">` },
        { type: "input_image", image_url: imageDataUri, detail: "original" },
        { type: "input_text", text: "</image>" },
        { type: "input_image", image_url: "data:image/webp;base64,UklGRg==" },
        { type: "input_audio", audio_url: "data:audio/wav;base64,UklGRg==", mimeType: "audio/wav", filename: "voice.wav" },
      ],
    },
  })}\n`, "utf8");

  const deadline = Date.now() + 1_000;
  while (!events.some((event) => event.type === "message.completed" && event.payload.messageId === "user-with-live-image") && Date.now() < deadline) {
    await delay(10);
  }
  const completed = events.find((event) => event.type === "message.completed" && event.payload.messageId === "user-with-live-image");
  assert.ok(completed);
  assert.equal(completed.nativeEvent, undefined);
  assert.equal(completed.payload.text, "The attached image should be visible.");
  assert.equal(completed.payload.requiresHistoryRefresh, true);
  assert.deepEqual(completed.payload.imageAttachments, [
    { name: "screen-capture.png", mimeType: "image/png" },
    { name: "Attached image", mimeType: "image/webp" },
  ]);
  const serialized = JSON.stringify(completed.payload);
  assert.equal(serialized.includes(imageDataUri), false);
  assert.doesNotMatch(serialized, /data:image|;base64,|C:\\\\Users|AppData|voice\.wav/iu);
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
