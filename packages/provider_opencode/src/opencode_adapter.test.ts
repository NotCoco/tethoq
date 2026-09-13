import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAdapterError, type ProviderEvent } from "../../provider_contract/src/index.js";
import type { JsonObject, RemoteSession } from "../../protocol/src/index.js";
import { type FetchLike } from "./http_client.js";
import type { OpenCodeActivityReadOptions, OpenCodeActivityReader } from "./activity.js";
import { OpenCodeAdapter as NativeOpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode_adapter.js";

// Lifecycle fixtures model a successful native prompt store. Keep that store
// behind the HTTP boundary; receipt-failure tests below use the unwrapped adapter.
// Single-workspace fixtures pin their directory; the routing tests exercise
// restoring and sharing project scopes through the actual metadata endpoint.
class OpenCodeAdapter extends NativeOpenCodeAdapter {
  constructor(options: OpenCodeAdapterOptions) {
    const receipts = new Map<string, unknown>();
    const fetchLike = options.fetch ?? globalThis.fetch;
    super({ ...options, fetch: async (input, init) => {
      const url = requestUrl(input);
      const receipt = receipts.get(url.pathname);
      if (init?.method === "GET" && receipt !== undefined) {
        receipts.delete(url.pathname);
        return jsonResponse(receipt);
      }
      const response = await fetchLike(input, init);
      if (init?.method === "POST" && url.pathname.endsWith("/prompt_async") && response.ok) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const sessionID = decodeURIComponent(url.pathname.split("/")[2]!);
        receipts.set(`/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(String(body.messageID))}`, {
          info: { id: body.messageID, sessionID, role: "user" }, parts: body.parts,
        });
      }
      return response;
    } });
  }
}

class SequenceActivityReader implements OpenCodeActivityReader {
  readonly #snapshots: readonly (ReadonlySet<string> | undefined)[];
  #index = 0;
  #changeListener: (() => void) | undefined;
  public closed = false;
  public reads = 0;
  public readonly candidateReads: ReadonlySet<string>[] = [];
  public readonly discoveryReads: boolean[] = [];
  public readonly completeDiscoveryReads: boolean[] = [];
  public readonly readStartedAt: number[] = [];
  public nextReadGate: Promise<void> | undefined;

  public constructor(...snapshots: readonly (ReadonlySet<string> | undefined)[]) {
    this.#snapshots = snapshots;
  }

  public async readWorkingSessionIds(
    sessionIds: ReadonlySet<string>,
    options: OpenCodeActivityReadOptions = {},
  ): Promise<ReadonlySet<string> | undefined> {
    this.reads += 1;
    this.readStartedAt.push(performance.now());
    this.candidateReads.push(new Set(sessionIds));
    this.discoveryReads.push(options.discoverRecent === true);
    this.completeDiscoveryReads.push(options.discoverAll === true);
    const gate = this.nextReadGate;
    this.nextReadGate = undefined;
    if (gate !== undefined) await gate;
    const snapshot = this.#snapshots[Math.min(this.#index, this.#snapshots.length - 1)];
    this.#index += 1;
    return snapshot;
  }

  public watchChanges(listener: () => void): () => void {
    this.#changeListener = listener;
    return () => {
      if (this.#changeListener === listener) this.#changeListener = undefined;
    };
  }

  public signalChange(): void {
    this.#changeListener?.();
  }

  public close(): void {
    this.closed = true;
  }
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("OpenCode sends images and stops in the task directory, resolving a restored task only once", async (t) => {
  const directory = "C:/Users/Example User/project";
  let metadataReads = 0;
  let stopped = false;
  const prompts: Record<string, unknown>[] = [];
  const adapter = new NativeOpenCodeAdapter({ hostId: "scoped-send", fetch: async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/restored") {
      metadataReads += 1;
      return jsonResponse({ id: "restored", directory });
    }
    assert.equal(url.searchParams.get("directory"), directory, "the request reached a different OpenCode Instance");
    if (url.pathname.endsWith("/prompt_async")) {
      prompts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/message/")) {
      const prompt = prompts.find((entry) => url.pathname.endsWith(String(entry.messageID)))!;
      return jsonResponse({ info: { id: prompt.messageID, sessionID: "restored", role: "user" }, parts: prompt.parts });
    }
    assert.equal(url.pathname, "/session/restored/abort");
    stopped = true;
    return jsonResponse(true);
  } });
  t.after(() => adapter.dispose());
  const image = { name: "image.png", mimeType: "image/png", dataBase64: "aW1hZ2U=", byteLength: 5 };
  assert.equal((await adapter.sendMessage("restored", { requestId: "one", content: "Inspect", attachments: [image] })).accepted, true);
  assert.equal((await adapter.steerMessage("restored", { requestId: "two", content: "Continue" })).accepted, true);
  await adapter.interrupt("restored");
  assert.equal(stopped, true);
  assert.equal(metadataReads, 1, "cached task routing must not add a metadata round trip to every send");
  assert.equal(prompts.length, 2);
  assert.deepEqual((prompts[0]!.parts as unknown[])[1], { type: "file", mime: "image/png", filename: "image.png", url: "data:image/png;base64,aW1hZ2U=" });
});

test("OpenCode directory status cannot idle another project or revive its orphaned SQLite turn", async (t) => {
  const directories = { a: "C:/project a", b: "C:/project b" };
  let aBusy = true;
  let bUnavailable = false;
  const adapter = new NativeOpenCodeAdapter({ hostId: "scoped-status", activityReader: new SequenceActivityReader(new Set(["a", "b", "external"])), fetch: async (input) => {
    const url = requestUrl(input);
    const id = url.pathname.split("/")[2] as "a" | "b";
    if (url.pathname !== "/session/status") return jsonResponse({ id, directory: directories[id], title: id, time: { created: 1, updated: 2 } });
    const scope = url.searchParams.get("directory");
    if (scope === directories.a) return jsonResponse(aBusy ? { a: { type: "busy" } } : {});
    if (scope === directories.b) return bUnavailable ? new Response(null, { status: 503 }) : jsonResponse({ b: { type: "busy" } });
    return jsonResponse({});
  } });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.getSession("a")).state, "working");
  assert.equal((await adapter.getSession("b")).state, "working");
  bUnavailable = true;
  assert.equal((await adapter.getSession("a")).state, "working");
  assert.equal(adapter.hasActiveTurn("b"), true, "another scope's successful empty map cannot erase B after its own status read failed");
  bUnavailable = false;
  aBusy = false;
  assert.equal((await adapter.getSession("a")).state, "idle");
  assert.equal(adapter.hasActiveTurn("a"), false, "an unfinished DB row is not a live runner");
  assert.deepEqual([...adapter.activeSessionIds()].sort(), ["b", "external"], "SQLite-only work on another server must remain visible");
  assert.equal((await adapter.getSession("b")).state, "working");
  assert.equal((await adapter.getSession("a")).state, "idle", "repeated refresh must not flicker back to working");
});

test("OpenCode waits past HTTP acknowledgement and a partial user header for the saved image", async (t) => {
  let body: Record<string, unknown> = {};
  let reads = 0;
  let settled = false;
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "receipt", requestTimeoutMs: 2_000, fetch: async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path.endsWith("/prompt_async")) {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }
    assert.equal(path, `/session/image-task/message/${String(body.messageID)}`);
    assert.equal(settled, false, "a transport ack or incomplete image consumed the composition");
    reads++;
    if (reads === 1) return new Response(null, { status: 404 });
    const text = { type: "text", text: "Inspect this" };
    const file = { type: "file", filename: "image.png", mime: "image/webp", url: "data:image/webp;base64,AQID" };
    return jsonResponse({ info: { id: body.messageID, sessionID: "image-task", role: "user" },
      parts: reads === 2 ? [] : reads === 3 ? [text] : reads === 4 ? [text, { ...file, url: "" }] : [text, file] });
  } });
  t.after(() => adapter.dispose());
  const result = await adapter.sendMessage("image-task", { requestId: "image-upload", content: "Inspect this",
    attachments: [{ name: "image.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" }] }).then(value => { settled = true; return value; });
  assert.equal(reads, 5);
  assert.equal(result.accepted, true);
  assert.equal(adapter.hasActiveTurn("image-task"), true);
});

test("OpenCode does not invent a running turn when an acknowledged prompt never persists", async (t) => {
  let body: Record<string, unknown> = {};
  let persist = false;
  let writes = 0;
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "receipt", requestTimeoutMs: 20, fetch: async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path.endsWith("/prompt_async")) {
      writes++;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }
    assert.equal(path, `/session/lost-task/message/${String(body.messageID)}`);
    return persist ? jsonResponse({ info: { id: body.messageID, role: "user" }, parts: body.parts }) : new Response(null, { status: 404 });
  } });
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.sendMessage("lost-task", { requestId: "lost", content: "Do the work" }), { code: "PROMPT_DELIVERY_UNCONFIRMED" });
  assert.equal(adapter.hasActiveTurn("lost-task"), false);
  assert.equal(writes, 1, "ambiguous delivery must not automatically duplicate a prompt");
  persist = true;
  assert.equal((await adapter.sendMessage("lost-task", { requestId: "next", content: "A later turn" })).accepted, true);
  assert.equal(adapter.hasActiveTurn("lost-task"), true);
});

test("OpenCode lost-response recovery requires the image parts, not just the saved user header", async (t) => {
  let body: Record<string, unknown> = {};
  let complete = false;
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "receipt", fetch: async (input, init) => {
    if (requestUrl(input).pathname.endsWith("/prompt_async")) {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new Error("socket closed");
    }
    return jsonResponse({ info: { id: body.messageID, role: "user" }, parts: complete ? body.parts : [] });
  } });
  t.after(() => adapter.dispose());
  const request = { requestId: "partial", content: "Inspect", attachments: [{ name: "image.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" }] };
  await assert.rejects(adapter.sendMessage("partial-task", request), { code: "HTTP_REQUEST_FAILED" });
  assert.equal(adapter.hasActiveTurn("partial-task"), false);
  complete = true;
  assert.equal((await adapter.sendMessage("partial-task", request)).accepted, true);
});

test("OpenCode scheduled retries cannot accept or resend a partially saved image", async (t) => {
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "receipt", requestTimeoutMs: 20, fetch: async (input, init) => {
    assert.equal(init?.method, "GET", "an incomplete prior delivery must not be posted again");
    const messageId = requestUrl(input).pathname.split("/").at(-1);
    return jsonResponse({ info: { id: messageId, role: "user" }, parts: [{ type: "text", text: "Inspect" }] });
  } });
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.sendMessage("partial-schedule", { requestId: "partial-schedule", content: "Inspect",
    metadata: { tethoqScheduledTaskId: "image-schedule" },
    attachments: [{ name: "image.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" }] }), { code: "PROMPT_DELIVERY_UNCONFIRMED" });
  assert.equal(adapter.hasActiveTurn("partial-schedule"), false);
});

test("OpenCode retries a stalled receipt read without posting the prompt again", async (t) => {
  let body: Record<string, unknown> = {};
  let reads = 0;
  let writes = 0;
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "stalled-receipt", requestTimeoutMs: 3_000, fetch: async (input, init) => {
    if (requestUrl(input).pathname.endsWith("/prompt_async")) {
      writes++;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }
    reads++;
    if (reads === 1) return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("first receipt read stalled")), { once: true });
    });
    return jsonResponse({ info: { id: body.messageID, role: "user" }, parts: body.parts });
  } });
  t.after(() => adapter.dispose());
  const result = await adapter.sendMessage("task", { requestId: "stalled-read", content: "continue" });
  assert.equal(result.accepted, true);
  assert.equal(adapter.hasActiveTurn("task"), true);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

test("OpenCode exact message lookup validates identity and never loads full history", async (t) => {
  let mode = "saved";
  let reads = 0;
  const adapter = new NativeOpenCodeAdapter({ hostId: "exact-receipt", fetch: async (input, init) => {
    reads++;
    assert.equal(init?.method, "GET");
    assert.equal(requestUrl(input).pathname, "/session/task/message/saved-id");
    if (mode === "missing") return new Response(null, { status: 404 });
    if (mode === "offline") throw new Error("offline");
    return jsonResponse({ info: { id: mode === "wrong-id" ? "other-id" : "saved-id", role: "user",
      sessionID: mode === "wrong-task" ? "other-task" : "task", time: { created: Date.now() } }, parts: [{ type: "text", text: "continue" }] });
  } });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.getMessage("task", "saved-id"))?.providerMessageId, "saved-id");
  for (mode of ["missing", "wrong-id", "wrong-task"]) assert.equal(await adapter.getMessage("task", "saved-id"), undefined);
  mode = "offline";
  await assert.rejects(adapter.getMessage("task", "saved-id"), { code: "HTTP_REQUEST_FAILED" });
  await adapter.dispose();
  assert.equal(await adapter.getMessage("task", "saved-id"), undefined);
  assert.equal(reads, 5, "a disposed adapter must not create another receipt request");
});

test("OpenCode detection explains the fixed default endpoint without starting another server", async (t) => {
  const fetchLike: FetchLike = async () => { throw new Error("connection refused"); };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  const detection = await adapter.detect();

  assert.equal(detection.available, false);
  assert.equal(detection.executable, "http://127.0.0.1:4096/");
  assert.match(detection.details.join(" "), /defaults to port 4096/);
  assert.match(detection.details.join(" "), /TETHOQ_OPENCODE_URL/);
  assert.match(detection.details.join(" "), /does not launch or discover/);
});

test("OpenCode detection gives a previously detected server one immediate second probe", async (t) => {
  let healthCalls = 0;
  const fetchLike: FetchLike = async () => {
    healthCalls += 1;
    if (healthCalls === 2) throw new Error("transient drop");
    return jsonResponse({ version: "1.2.3" });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  const first = await adapter.detect();
  assert.equal(first.available, true);

  const second = await adapter.detect();

  assert.equal(second.available, true);
  assert.equal(healthCalls, 3, "one dropped probe must not disable detection");
});

test("OpenCode detection does not double-probe a server that never answered", async (t) => {
  let healthCalls = 0;
  const fetchLike: FetchLike = async () => {
    healthCalls += 1;
    throw new Error("connection refused");
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  const detection = await adapter.detect();

  assert.equal(detection.available, false);
  assert.equal(healthCalls, 1);
});

test("OpenCode detection reports the first failure when both probes fail", async (t) => {
  let healthCalls = 0;
  const fetchLike: FetchLike = async () => {
    healthCalls += 1;
    if (healthCalls === 1) return jsonResponse({ version: "1.0.0" });
    throw new Error(healthCalls === 2 ? "first failure" : "second failure");
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  await adapter.detect();
  const detection = await adapter.detect();

  assert.equal(detection.available, false);
  assert.equal(healthCalls, 3);
  assert.match(detection.details.join(" "), /first failure/);
});

test("OpenCode lists only connected upstream models and preserves their route", async () => {
  const fetchLike: FetchLike = async (input) => {
    assert.equal(requestUrl(input).pathname, "/provider");
    return jsonResponse({
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet-4-5" },
      all: [
        { id: "openai", name: "OpenAI", models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } } },
        { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } } },
      ],
    });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const models = await adapter.listModels();

  assert.deepEqual(models.map((model) => model.id), ["anthropic/claude-sonnet-4-5"]);
  assert.equal(models[0]?.isDefault, true);
  assert.deepEqual(models[0]?.nativeMetadata, {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    sourceProviderId: "anthropic",
    sourceProviderName: "Anthropic",
    source: "OpenCode",
  });
  await adapter.dispose();
});

test("OpenCode async prompts use a stable native message ID separate from bridge deduplication", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/session/ses_1/prompt_async");
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    requestBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({ directory: "C:/fixture", hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const request = {
    requestId: "bridge_request_1",
    content: "Run the focused tests",
    developerInstructions: "Use the configured EYES tool before answering image questions.",
    modelId: "openai/gpt-5",
    reasoningEffort: "high",
    attachments: [{ name: "phone.jpg", mimeType: "image/jpeg", dataBase64: "AQID", byteLength: 3 }],
  } as const;
  const result = await adapter.sendMessage("ses_1", request);
  const repeated = await adapter.sendMessage("ses_1", request);

  const requestBody = requestBodies[0];
  assert.ok(requestBody);
  const messageID = requestBody.messageID;
  assert.ok(typeof messageID === "string");
  assert.match(messageID, /^msg_[a-f0-9]{32}$/u);
  assert.notEqual(messageID, "bridge_request_1");
  assert.equal(requestBodies[1]?.messageID, messageID, "a safe retry changed OpenCode's native message identity");
  assert.deepEqual(requestBody.parts, [
    { type: "text", text: "Run the focused tests" },
    { type: "file", mime: "image/jpeg", filename: "phone.jpg", url: "data:image/jpeg;base64,AQID" },
  ]);
  assert.deepEqual(requestBody.model, { providerID: "openai", modelID: "gpt-5" });
  assert.equal(requestBody.system, "Use the configured EYES tool before answering image questions.");
  assert.deepEqual(requestBody.tools, {
    uar_mesh_ask_eyes: false,
    uar_mesh_tethoq_turn_support: false,
  },
    "EYES guidance-like prose must not expose the task-scoped tool without an explicit Bridge grant");
  assert.doesNotMatch(JSON.stringify(requestBody.parts), /configured EYES tool/u,
    "native hidden instructions must not be duplicated into the visible user message");
  assert.equal(requestBody.variant, "high");
  assert.deepEqual(result, {
    accepted: true,
    providerTurnId: messageID,
    details: ["OpenCode accepted the asynchronous prompt."],
  });
  assert.equal(repeated.providerTurnId, messageID);
});

test("OpenCode EYES shares the existing workspace and removes all tools on every helper turn", async (t) => {
  const calls: Array<{ path: string; directory: string | null; body: Record<string, unknown> }> = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path: url.pathname, directory: url.searchParams.get("directory"), body });
    if (url.pathname === "/path") return jsonResponse({ directory: "C:\\existing-server" });
    if (url.pathname === "/session") return jsonResponse({ id: "eyes", title: "Visual support", directory: "C:\\existing-server", time: { created: 1, updated: 1 } });
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });
  t.after(() => adapter.dispose());
  const helper = await adapter.createSession({ workingDirectory: "C:\\unrelated-parent", metadata: { internalPurpose: "vision_proxy" } });
  await adapter.sendMessage(helper.providerSessionId, { requestId: "helper", content: "Inspect", clientToolOverrides: { ask_eyes: true } });
  await adapter.sendMessage("restored-eyes", { requestId: "restored", content: "Inspect", metadata: { internalPurpose: "vision_proxy" } });
  await adapter.sendMessage("normal", { requestId: "normal", content: "Build", clientToolOverrides: { ask_eyes: true } });
  const creation = calls.find(call => call.path === "/session")!;
  assert.equal(creation.directory, "C:\\existing-server");
  assert.deepEqual(creation.body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
  const prompts = calls.filter(call => call.path.endsWith("/prompt_async"));
  assert.deepEqual(prompts.map(call => call.body.tools), [
    { "*": false }, { "*": false }, { uar_mesh_ask_eyes: true, uar_mesh_tethoq_turn_support: true },
  ]);
  assert.equal(calls.some(call => call.path === "/config" || call.path === "/mcp"), false);
});

test("OpenCode confirms a persisted stable prompt after its HTTP response disconnects", async (t) => {
  let persistedMessageId: string | undefined;
  const calls: string[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/session/ses_ambiguous_send/prompt_async") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(typeof body.messageID, "string");
      persistedMessageId = String(body.messageID);
      throw new Error("socket closed after OpenCode persisted the prompt");
    }
    assert.equal(url.pathname, `/session/ses_ambiguous_send/message/${persistedMessageId}`);
    return jsonResponse({
      info: {
        id: persistedMessageId,
        sessionID: "ses_ambiguous_send",
        role: "user",
        time: { created: 1 },
      },
      parts: [{ id: "persisted-text", type: "text", text: "Keep the optimistic row" }],
    });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_ambiguous_send",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  const result = await adapter.sendMessage("ses_ambiguous_send", {
    requestId: "ambiguous-send-request",
    content: "Keep the optimistic row",
  });

  assert.deepEqual(result, {
    accepted: true,
    providerTurnId: persistedMessageId,
    details: ["OpenCode accepted the asynchronous prompt before its response disconnected."],
  });
  assert.deepEqual(calls, [
    "POST /session/ses_ambiguous_send/prompt_async",
    `GET /session/ses_ambiguous_send/message/${persistedMessageId}`,
  ]);
  assert.equal(adapter.hasActiveTurn("ses_ambiguous_send"), true, "acceptance recovery rolled back the owned turn");
});

test("OpenCode rethrows the original prompt error when exact history does not prove acceptance", async (t) => {
  let persistedMessageId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/ses_rejected_send/prompt_async") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      persistedMessageId = String(body.messageID);
      return new Response("dispatch failed", { status: 503 });
    }
    assert.equal(url.pathname, `/session/ses_rejected_send/message/${persistedMessageId}`);
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_rejected_send",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  await assert.rejects(
    () => adapter.sendMessage("ses_rejected_send", {
      requestId: "rejected-send-request",
      content: "Roll this row back",
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
        "HTTP_503",
        "the exact-read 404 replaced the original prompt_async failure",
      );
      return true;
    },
  );
  assert.equal(adapter.hasActiveTurn("ses_rejected_send"), false, "a definite failure left a phantom owned turn");
});

test("OpenCode preserves native PDF attachments when the selected model explicitly supports PDF input", async (t) => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/provider") {
      return jsonResponse({
        connected: ["native-pdf"],
        all: [{
          id: "native-pdf",
          models: {
            reader: { id: "reader", capabilities: { input: { pdf: true } } },
          },
        }],
      });
    }
    assert.equal(url.pathname, "/session/ses_pdf/prompt_async");
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_pdf",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  await adapter.sendMessage("ses_pdf", {
    requestId: "pdf-shape",
    content: "Read the sentence.",
    modelId: "native-pdf/reader",
    attachments: [{
      name: "one-sentence.pdf",
      mimeType: "application/pdf",
      dataBase64: "JVBERi0xLjQKJSBURVRIT1EgUERGCg==",
      byteLength: 22,
    }],
  });

  assert.deepEqual(requestBody?.parts, [
    { type: "text", text: "Read the sentence." },
    {
      type: "file",
      mime: "application/pdf",
      filename: "one-sentence.pdf",
      url: "data:application/pdf;base64,JVBERi0xLjQKJSBURVRIT1EgUERGCg==",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(requestBody), /byteLength/u, "renderer-only size metadata leaked into OpenCode's file part");
});

test("OpenCode grants turn support only for the explicitly routed task turn", async (t) => {
  const requestBodies: { readonly sessionId: string; readonly body: Record<string, unknown> }[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    const match = /^\/session\/([^/]+)\/prompt_async$/u.exec(url.pathname);
    assert.ok(match);
    requestBodies.push({
      sessionId: decodeURIComponent(match[1]!),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_eyes_scope",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  await adapter.sendMessage("configured", {
    requestId: "configured-image-turn",
    content: "Inspect the routed image",
    clientToolOverrides: { ask_eyes: true },
  });
  await adapter.sendMessage("fresh", {
    requestId: "fresh-native-image-turn",
    content: "Inspect this image directly",
  });
  await adapter.sendMessage("configured", {
    requestId: "configured-text-followup",
    content: "Continue without an image",
  });

  assert.deepEqual(requestBodies.map(({ sessionId, body }) => [sessionId, body.tools]), [
    ["configured", { uar_mesh_ask_eyes: true, uar_mesh_tethoq_turn_support: true }],
    ["fresh", { uar_mesh_ask_eyes: false, uar_mesh_tethoq_turn_support: false }],
    ["configured", { uar_mesh_ask_eyes: false, uar_mesh_tethoq_turn_support: false }],
  ]);
});

test("OpenCode scheduled retries do not resend a prompt already present in native history", async () => {
  let acceptedMessageId: string | undefined;
  let promptWrites = 0;
  let historyReads = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname.startsWith("/session/ses_scheduled/message/")) {
      historyReads += 1;
      if (acceptedMessageId === undefined) return new Response("not found", { status: 404 });
      assert.equal(url.pathname, `/session/ses_scheduled/message/${acceptedMessageId}`);
      return jsonResponse({
        info: {
          id: acceptedMessageId,
          sessionID: "ses_scheduled",
          role: "user",
          time: { created: 1 },
        },
        parts: [{ id: "scheduled-text", type: "text", text: "Run the scheduled task" }],
      });
    }
    assert.equal(url.pathname, "/session/ses_scheduled/prompt_async");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(typeof body.messageID, "string");
    acceptedMessageId = String(body.messageID);
    promptWrites += 1;
    return new Response(null, { status: 204 });
  };
  const adapter = new NativeOpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const request = {
    requestId: "schedule_opencode_exactly_once",
    content: "Run the scheduled task",
    metadata: { tethoqScheduledTaskId: "schedule_opencode_exactly_once" },
  } as const;
  const first = await adapter.sendMessage("ses_scheduled", request);
  const retry = await adapter.sendMessage("ses_scheduled", request);

  assert.equal(promptWrites, 1, "the persisted scheduled prompt was posted twice");
  assert.equal(historyReads, 3);
  assert.equal(retry.providerTurnId, first.providerTurnId);
  assert.deepEqual(retry.details, ["OpenCode already accepted this scheduled prompt."]);
  await adapter.dispose();
});

test("OpenCode scheduled retries fail closed when native message history is unavailable", async () => {
  let promptWrites = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname.startsWith("/session/ses_scheduled_failure/message/")) {
      return new Response("unavailable", { status: 500 });
    }
    promptWrites += 1;
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  await assert.rejects(
    () => adapter.sendMessage("ses_scheduled_failure", {
      requestId: "schedule_opencode_history_failure",
      content: "Do not duplicate this scheduled task",
      metadata: { tethoqScheduledTaskId: "schedule_opencode_history_failure" },
    }),
    /OpenCode returned 500/,
  );
  assert.equal(promptWrites, 0, "an unverified scheduled retry reached prompt_async");
  await adapter.dispose();
});

test("OpenCode omits the internal default effort sentinel from native prompts", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchLike: FetchLike = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({ directory: "C:/fixture", hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  await adapter.sendMessage("ses_default", {
    requestId: "bridge_request_default",
    content: "Use the model's native default",
    modelId: "opencode-go/glm-5.3-flash",
    reasoningEffort: "default",
  });

  assert.ok(requestBody);
  assert.equal(Object.hasOwn(requestBody, "variant"), false);
  await adapter.dispose();
});

test("OpenCode requests a paused snapshot instead of silently dropping the latest exchange", async () => {
  let requestBody: unknown;
  let forkedMessageIds: string[] = [];
  const sourceHistory = [
    {
      info: { id: "user_safe", sessionID: "source", role: "user", time: { created: 1 } },
      parts: [{ id: "safe_prompt", type: "text", text: "Complete this" }],
    },
    {
      info: {
        id: "assistant_safe",
        sessionID: "source",
        role: "assistant",
        parentID: "user_safe",
        finish: "stop",
        time: { created: 2, completed: 3 },
      },
      parts: [{ id: "safe_text", type: "text", text: "Completed history" }],
    },
    {
      info: { id: "user_active", sessionID: "source", role: "user", time: { created: 4 } },
      parts: [{ id: "active_prompt", type: "text", text: "Still running" }],
    },
    {
      info: { id: "assistant_active", sessionID: "source", role: "assistant", parentID: "user_active", time: { created: 5 } },
      parts: [{ id: "active_reasoning", type: "reasoning", text: "Not complete" }],
    },
  ];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/source/message") return jsonResponse(sourceHistory);
    assert.equal(url.pathname, "/session/source/fork");
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body));
    const boundaryId = typeof requestBody === "object" && requestBody !== null && !Array.isArray(requestBody)
      && typeof (requestBody as Record<string, unknown>).messageID === "string"
      ? (requestBody as Record<string, unknown>).messageID as string
      : undefined;
    const boundaryIndex = boundaryId === undefined
      ? sourceHistory.length
      : sourceHistory.findIndex((entry) => entry.info.id === boundaryId);
    assert.ok(boundaryIndex >= 0, "the adapter supplied an unknown native fork boundary");
    forkedMessageIds = sourceHistory.slice(0, boundaryIndex).map((entry) => entry.info.id);
    return jsonResponse({
      id: "forked",
      directory: "C:\\workspace",
      title: "Forked history",
      time: { created: 1, updated: 2 },
    });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  await assert.rejects(adapter.branchSession("source"), (error: unknown) => error instanceof ProviderAdapterError && error.code === "BRANCH_SNAPSHOT_REQUIRED");
  assert.equal(requestBody, undefined, "an incomplete native fork was created");
  assert.deepEqual(forkedMessageIds, []);
  await adapter.dispose();
});

test("OpenCode forks all history when the completed response is already the safe tail", async () => {
  let requestBody: unknown;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/source/message") return jsonResponse([
      {
        info: { id: "user_safe", sessionID: "source", role: "user", time: { created: 1 } },
        parts: [{ id: "safe_prompt", type: "text", text: "Complete this" }],
      },
      {
        info: {
          id: "assistant_safe",
          sessionID: "source",
          role: "assistant",
          parentID: "user_safe",
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
        parts: [{ id: "safe_text", type: "text", text: "Done" }],
      },
    ]);
    assert.equal(url.pathname, "/session/source/fork");
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse({ id: "forked", directory: "C:\\workspace", title: "Safe fork", time: { created: 1, updated: 2 } });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const session = await adapter.branchSession("source");

  assert.equal(session.providerSessionId, "forked");
  assert.deepEqual(requestBody, {}, "an exclusive boundary at the safe assistant would drop the completed response");
  await adapter.dispose();
});

test("OpenCode serializes a safe-tail fork against a concurrent Tethoq send", async () => {
  const calls: string[] = [];
  let markHistoryStarted = (): void => {};
  const historyStarted = new Promise<void>((resolve) => { markHistoryStarted = resolve; });
  let releaseHistory = (): void => {};
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/source/message") {
      calls.push("history:start");
      markHistoryStarted();
      await historyGate;
      calls.push("history:end");
      return jsonResponse([
        {
          info: { id: "user_safe", sessionID: "source", role: "user", time: { created: 1 } },
          parts: [{ id: "safe_prompt", type: "text", text: "Complete this" }],
        },
        {
          info: {
            id: "assistant_safe",
            sessionID: "source",
            role: "assistant",
            parentID: "user_safe",
            finish: "stop",
            time: { created: 2, completed: 3 },
          },
          parts: [{ id: "safe_text", type: "text", text: "Done" }],
        },
      ]);
    }
    if (url.pathname === "/session/source/fork") {
      calls.push("fork");
      return jsonResponse({ id: "forked", directory: "C:\\workspace", title: "Safe fork", time: { created: 1, updated: 2 } });
    }
    if (url.pathname === "/session/source/prompt_async") {
      calls.push("send");
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const branch = adapter.branchSession("source");
  await historyStarted;
  const send = adapter.sendMessage("source", { requestId: "concurrent_send", content: "Do not enter the fork" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["history:start"], "the concurrent prompt escaped while the safe branch point was being read");

  releaseHistory();
  const [forked, sent] = await Promise.all([branch, send]);

  assert.equal(forked.providerSessionId, "forked");
  assert.equal(sent.accepted, true);
  assert.deepEqual(calls, ["history:start", "history:end", "fork", "send"]);
  await adapter.dispose();
});

test("OpenCode session listing keeps a small native request and its local continuation snapshot bounded", async () => {
  const nativeSessions = Array.from({ length: 1_000 }, (_, index) => ({
    id: `ses_${index}`,
    directory: "/workspace/project",
    title: `Session ${index}`,
    time: { created: 1_000 - index, updated: 1_000 - index },
  }));
  let nativeListUrl: URL | undefined;
  let nativeListReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") {
      nativeListReads += 1;
      nativeListUrl = url;
      // Simulate an older server that ignores the query limit. The adapter must
      // still keep only its bounded recent snapshot.
      return jsonResponse(nativeSessions);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await adapter.listSessions({ limit: 20, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.sessions.map((session) => session.providerSessionId));
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) break;
  } while (true);

  assert.ok(nativeListUrl);
  assert.equal(nativeListUrl.searchParams.get("limit"), "100");
  assert.equal(nativeListReads, 1);
  assert.deepEqual(ids, Array.from({ length: 100 }, (_, index) => `ses_${index}`));
  assert.equal(new Set(ids).size, 100);
  await adapter.dispose();
});

test("OpenCode refuses to branch a non-empty task with no completed response", async () => {
  let forkCalls = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/source/message") return jsonResponse([{
      info: { id: "assistant_active", sessionID: "source", role: "assistant", parentID: "user_active", time: { created: 1 } },
      parts: [{ id: "active_reasoning", type: "reasoning", text: "Still running" }],
    }]);
    if (url.pathname === "/session/source/fork") forkCalls += 1;
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  await assert.rejects(() => adapter.branchSession("source"), /paused snapshot/i);
  assert.equal(forkCalls, 0);
  await adapter.dispose();
});

test("OpenCode can still fork a genuinely empty task", async () => {
  let requestBody: unknown;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/source/message") return jsonResponse([]);
    if (url.pathname === "/session/source/fork") {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ id: "forked", directory: "C:\\workspace", title: "Empty fork", time: { created: 1, updated: 1 } });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const session = await adapter.branchSession("source");
  assert.equal(session.providerSessionId, "forked");
  assert.deepEqual(requestBody, {});
  await adapter.dispose();
});

test("OpenCode multi-page listing reads and normalizes the native session snapshot once per cycle", async () => {
  const nativeSessions = Array.from({ length: 121 }, (_, index) => ({
    id: `cycle_${index}`,
    directory: "/workspace/project",
    title: `Cycle ${index}`,
    time: { created: index, updated: index },
  }));
  let sessionReads = 0;
  let statusReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") {
      sessionReads += 1;
      return jsonResponse(nativeSessions);
    }
    if (url.pathname === "/session/status") {
      statusReads += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(new Set());
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: reader });

  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await adapter.listSessions({ limit: 40, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.sessions.map((session) => session.providerSessionId));
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) break;
  } while (true);

  assert.equal(ids.length, 121);
  assert.equal(new Set(ids).size, 121);
  assert.deepEqual(ids, Array.from({ length: 121 }, (_, index) => `cycle_${120 - index}`));
  assert.equal(sessionReads, 1);
  assert.equal(statusReads, 1);
  assert.equal(reader.reads, 1, "the first page waits for one bounded startup activity snapshot");

  await adapter.listSessions({ limit: 40 });
  assert.equal(sessionReads, 2, "a later cursorless refresh starts a fresh native read cycle");
  assert.equal(statusReads, 2);
  assert.equal(reader.reads, 1, "later catalogue cycles reuse the startup activity snapshot");
  await adapter.dispose();
});

test("OpenCode live provider events invalidate an in-progress list snapshot", async () => {
  const nativeSessions = [
    { id: "event_0", title: "First", time: { created: 0, updated: 0 } },
    { id: "event_1", title: "Second", time: { created: 1, updated: 1 } },
  ];
  let sessionReads = 0;
  let servedEvent = false;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") {
      sessionReads += 1;
      return jsonResponse(nativeSessions);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    if (url.pathname === "/global/event" && !servedEvent) {
      servedEvent = true;
      return new Response(`data: ${JSON.stringify({ payload: {
        type: "session.updated",
        properties: { info: nativeSessions[1] },
      } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === "/global/event") {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new Error("aborted"));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const first = await adapter.listSessions({ limit: 1 });
  assert.ok(first.nextCursor);
  let updateSeen = false;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.updated") updateSeen = true;
  });
  const deadline = Date.now() + 1_000;
  while (!updateSeen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(updateSeen, true);

  await adapter.listSessions({ cursor: first.nextCursor, limit: 1 });
  assert.equal(sessionReads, 2);
  await adapter.dispose();
});

test("OpenCode child-session pagination uses the dedicated child list instead of a bounded root catalogue", async () => {
  let broadListReads = 0;
  let childListReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/root/children") {
      childListReads += 1;
      return jsonResponse([
        { id: "child-a", parentID: "root", agent: "build", model: { providerID: "openai", id: "gpt-a", variant: "high" }, title: "A", time: { created: 2, updated: 2 } },
        { id: "child-b", parentID: "root", agent: "plan", model: { providerID: "openai", id: "gpt-b" }, title: "B", time: { created: 3, updated: 3 } },
      ]);
    }
    if (url.pathname === "/session") {
      broadListReads += 1;
      return jsonResponse(Array.from({ length: 200 }, (_, index) => ({
        id: `unrelated-${index}`,
        title: "Unrelated",
        time: { created: 1_000 - index, updated: 1_000 - index },
      })));
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const first = await adapter.listSessions({ parentProviderSessionId: "root", limit: 1 });
  assert.ok(first.nextCursor);
  const second = await adapter.listSessions({ parentProviderSessionId: "root", cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(first.sessions.map((session) => session.providerSessionId), ["child-b"]);
  assert.equal(first.sessions[0]?.parentSessionId, "host_1/opencode/root");
  assert.equal(first.sessions[0]?.modelId, "openai/gpt-b");
  assert.equal(first.sessions[0]?.variantId, "default");
  assert.equal(first.sessions[0]?.reasoningEffort, "default");
  assert.deepEqual(second.sessions.map((session) => session.providerSessionId), ["child-a"]);
  assert.equal(second.sessions[0]?.variantId, "high");
  assert.equal(second.nextCursor, null);
  assert.equal(childListReads, 1);
  assert.equal(broadListReads, 0, "child paging must not lose old children behind the bounded root catalogue");
  await adapter.dispose();
});

test("OpenCode history opens with a bounded latest-message window", async () => {
  let historyUrl: URL | undefined;
  const fetchLike: FetchLike = async (input) => {
    historyUrl = requestUrl(input);
    return jsonResponse([]);
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const messages = await adapter.getMessages("ses_large");

  assert.deepEqual(messages, []);
  assert.ok(historyUrl);
  assert.equal(historyUrl.pathname, "/session/ses_large/message");
  assert.equal(historyUrl.searchParams.get("limit"), "500");
  await adapter.getMessages("ses_large", { limit: 8 });
  assert.equal(historyUrl.searchParams.get("limit"), "8", "worker result reads should fetch only the requested recent tail");
  await adapter.dispose();
});

test("OpenCode listing uses cached persisted work only when native status is unavailable", async () => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session") return jsonResponse([
      { id: "persisted", title: "Persisted", time: { created: 1, updated: 2 } },
      { id: "native-idle", title: "Native idle", time: { created: 1, updated: 2 } },
    ]);
    if (url.pathname === "/session/status") return jsonResponse({ "native-idle": { type: "idle" } });
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(new Set(["persisted", "native-idle"]));
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
  });
  let persistedWorkingSeen = false;
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "persisted" && event.type === "session.status_changed" && event.payload.state === "working") {
      persistedWorkingSeen = true;
    }
  });
  await waitFor(() => persistedWorkingSeen, "the independent activity watcher must populate its cached state");

  const page = await adapter.listSessions();

  assert.equal(page.sessions.find((session) => session.providerSessionId === "persisted")?.state, "working");
  assert.equal(page.sessions.find((session) => session.providerSessionId === "native-idle")?.state, "idle");
  await adapter.dispose();
  assert.equal(reader.closed, true);
});

test("OpenCode listing reports idle for sessions with no native status and no active turn", async () => {
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") return jsonResponse([{ id: "quiet", title: "Quiet", time: { created: 1, updated: 2 } }]);
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const page = await adapter.listSessions();

  assert.equal(page.sessions[0]?.state, "idle", "a session with no reported state and no in-flight turn is idle, not perpetually working");
  await adapter.dispose();
});

test("OpenCode history rehydrates final output produced across a Tethoq generation restart", async () => {
  const history: Array<Record<string, unknown>> = [{
    info: {
      id: "user_restart",
      sessionID: "ses_restart",
      role: "user",
      time: { created: 1 },
    },
    parts: [{ id: "user_restart_text", type: "text", text: "Keep working while the shell reconnects" }],
  }, {
    info: {
      id: "assistant_restart",
      sessionID: "ses_restart",
      role: "assistant",
      parentID: "user_restart",
      time: { created: 2 },
    },
    parts: [{ id: "assistant_restart_reasoning", type: "reasoning", text: "Still working" }],
  }];
  const fetchLike: FetchLike = async (input) => requestUrl(input).pathname === "/session/ses_restart/message"
    ? jsonResponse(history)
    : new Response("not found", { status: 404 });

  const first = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(["ses_restart"])),
  });
  const beforeRestart = await first.getMessages("ses_restart");
  assert.equal(beforeRestart.at(-1)?.status, "streaming");
  await first.dispose();

  history[1] = {
    info: {
      id: "assistant_restart",
      sessionID: "ses_restart",
      role: "assistant",
      parentID: "user_restart",
      finish: "stop",
      time: { created: 2, completed: 4 },
    },
    parts: [
      { id: "assistant_restart_reasoning", type: "reasoning", text: "Still working" },
      { id: "assistant_restart_text", type: "text", text: "The durable run completed." },
    ],
  };
  const replacement = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  const afterRestart = await replacement.getMessages("ses_restart");

  assert.equal(afterRestart.at(-1)?.status, "completed");
  assert.equal(afterRestart.at(-1)?.parts.some((part) => part.type === "text" && part.text === "The durable run completed."), true);
  await replacement.dispose();
});

test("OpenCode listing preserves unknown when the bounded startup activity source is unavailable", async () => {
  let activityReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") return jsonResponse([{ id: "unproven", title: "Unproven", time: { created: 1, updated: 2 } }]);
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: {
      async readWorkingSessionIds() {
        activityReads += 1;
        return undefined;
      },
      close() {},
    },
  });

  const page = await adapter.listSessions();

  assert.equal(activityReads, 1);
  assert.equal(page.sessions[0]?.state, "unknown", "empty status is not idle authority when persisted activity could not be read");
  await adapter.dispose();
});

test("OpenCode keeps a known busy state across a failed status refresh but clears it on an authoritative empty snapshot", async () => {
  let statusReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") return jsonResponse([
      { id: "external-busy", title: "External busy", time: { created: 1, updated: 2 } },
    ]);
    if (url.pathname === "/session/status") {
      statusReads += 1;
      if (statusReads === 1) return jsonResponse({ "external-busy": { type: "busy" } });
      if (statusReads === 2) return new Response("temporarily unavailable", { status: 503 });
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  assert.equal((await adapter.listSessions()).sessions[0]?.state, "working");
  assert.equal((await adapter.listSessions()).sessions[0]?.state, "working", "a transport failure is unknown, not idle");
  assert.equal((await adapter.listSessions()).sessions[0]?.state, "idle", "a successful empty status snapshot clears the old busy state");

  await adapter.dispose();
});

test("OpenCode persisted activity watcher emits working and idle transitions", async () => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => requestUrl(input).pathname === "/global/event"
    ? events.response(init?.signal ?? undefined)
    : new Response("not found", { status: 404 });
  const reader = new SequenceActivityReader(new Set(["desktop-session"]), new Set());
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 5,
  });
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
  });
  const deadline = Date.now() + 1_000;
  while (states.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(states.slice(0, 2), ["working", "idle"]);
  await adapter.dispose();
  assert.equal(reader.closed, true);
});

test("known external activity settles promptly even when its filesystem wake is missed", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => requestUrl(input).pathname === "/global/event"
    ? events.response(init?.signal ?? undefined)
    : new Response("not found", { status: 404 });
  const reader = new SequenceActivityReader(new Set(["desktop-session"]), new Set());
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: Array<{ readonly state: string; readonly at: number }> = [];
  const startedAt = performance.now();
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") {
      states.push({ state: event.payload.state, at: performance.now() - startedAt });
    }
  });

  await waitFor(() => states.some(({ state }) => state === "idle"), "the exact known-active safety read must settle the missed completion wake");

  assert.deepEqual(states.map(({ state }) => state), ["working", "idle"]);
  assert.ok((states.at(-1)?.at ?? Number.POSITIVE_INFINITY) < 2_750, `missed completion wake settled after ${states.at(-1)?.at.toFixed(1)}ms`);
  assert.deepEqual(reader.discoveryReads.slice(0, 2), [true, false], "only the startup read is provider-wide");
  assert.deepEqual([...(reader.candidateReads[1] ?? [])], ["desktop-session"], "the fast fallback rechecks only the known active id");
});

test("OpenCode database changes discover external work and exact checks retain it until idle", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/status") return jsonResponse({});
    if (url.pathname === "/project") return jsonResponse([]);
    if (url.pathname === "/session") return jsonResponse([{
      id: "desktop-owned",
      directory: "/external/project",
      title: "Desktop owned",
      time: { created: 1, updated: 2 },
    }]);
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(
    new Set(["desktop-owned"]),
    new Set(["desktop-owned"]),
    new Set(),
  );
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
    activityDiscoveryIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  const catalogueSignals: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "desktop-owned" && event.type === "session.status_changed") {
      states.push(String(event.payload.state));
    }
    if (event.providerSessionId === "desktop-owned" && event.type === "session.updated" && event.payload.activityDiscovered === true) {
      catalogueSignals.push(event.providerSessionId);
    }
  });

  await waitFor(() => states[0] === "working", "startup discovery must recover external work without selecting its task");
  await waitFor(() => catalogueSignals.length === 1, "new external activity must invalidate the bounded catalogue so an unloaded task can materialize");
  assert.equal(reader.discoveryReads[0], true);
  assert.equal(reader.completeDiscoveryReads[0], true, "startup must reconcile the complete lightweight catalogue");
  assert.equal(reader.candidateReads[0]?.size, 0);
  const materialized = await adapter.listSessions();
  assert.equal(materialized.sessions.find((session) => session.providerSessionId === "desktop-owned")?.state, "working");

  reader.signalChange();
  await waitFor(() => reader.reads >= 2, "a WAL change must wake the activity loop instead of waiting for the safety poll");
  assert.equal(reader.discoveryReads[1], false, "provider-wide discovery is throttled between change wakes");
  assert.deepEqual([...(reader.candidateReads[1] ?? [])], ["desktop-owned"], "known-active work is reconciled by exact id");

  reader.signalChange();
  await waitFor(() => states.includes("idle"), "an exact change-triggered check must publish the external task's idle transition");
  assert.deepEqual(states, ["working", "idle"]);
});

test("OpenCode startup and reconnect preserve every simultaneous Desktop-owned active task", async () => {
  const runGeneration = async (): Promise<void> => {
    const events = new SseFixture();
    const fetchLike: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
      if (url.pathname === "/session/status") return jsonResponse({});
      if (url.pathname === "/project") return jsonResponse([]);
      if (url.pathname === "/session") return jsonResponse([
        { id: "desktop-owned-a", directory: "/external/a", title: "External A", time: { created: 1, updated: 4 } },
        { id: "desktop-owned-b", directory: "/external/b", title: "External B", time: { created: 2, updated: 3 } },
      ]);
      return new Response("not found", { status: 404 });
    };
    const reader = new SequenceActivityReader(new Set(["desktop-owned-a", "desktop-owned-b"]));
    const adapter = new OpenCodeAdapter({
      hostId: "host_1",
      // This represents Tethoq's managed server: it owns neither external turn
      // and therefore reports an empty native status map. Persisted activity is
      // the provider-wide recovery path when Desktop's authenticated server
      // cannot be adopted directly.
      baseUrl: "http://127.0.0.1:4096/",
      fetch: fetchLike,
      activityReader: reader,
      activityPollIntervalMs: 60_000,
    });
    const working = new Set<string>();
    await adapter.subscribe(null, (event) => {
      if (event.type === "session.status_changed" && event.payload.state === "working" && event.providerSessionId) {
        working.add(event.providerSessionId);
      }
    });

    const page = await adapter.listSessions();
    await waitFor(() => working.size === 2, "both externally owned tasks must publish working state");
    assert.deepEqual([...working].sort(), ["desktop-owned-a", "desktop-owned-b"]);
    assert.deepEqual([...adapter.activeSessionIds()].sort(), ["desktop-owned-a", "desktop-owned-b"],
      "server handoff must retain every provider- or database-owned active task, not only prompts sent by Tethoq");
    assert.deepEqual(page.sessions.map((session) => [session.providerSessionId, session.state]), [
      ["desktop-owned-a", "working"],
      ["desktop-owned-b", "working"],
    ]);
    assert.equal(reader.discoveryReads[0], true, "each adapter generation rehydrates provider-wide activity before its first page");
    assert.equal(reader.completeDiscoveryReads[0], true, "every adapter generation performs one complete startup safety read");
    await adapter.dispose();
  };

  await runGeneration();
  await runGeneration();
});

test("OpenCode provider-wide status polling unions native and SQLite work and preserves the last native snapshot on failure", async (t) => {
  const events = new SseFixture();
  let statusCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname !== "/session/status") return new Response("not found", { status: 404 });
    statusCalls += 1;
    if (statusCalls === 1) return jsonResponse({ "native-active": { type: "busy" } });
    if (statusCalls === 2) throw new Error("temporary status outage");
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(["sqlite-active"])),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 20,
  });
  t.after(() => adapter.dispose());
  const states: Array<{ id: string; state: string }> = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId !== undefined && event.type === "session.status_changed") {
      states.push({ id: event.providerSessionId, state: String(event.payload.state) });
    }
  });

  await waitFor(() => adapter.activeSessionIds().includes("native-active") && adapter.activeSessionIds().includes("sqlite-active"),
    "the unselected native task and SQLite-only task must both become active");
  await waitFor(() => statusCalls >= 2, "the bounded native poll must retry after its first snapshot");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual([...adapter.activeSessionIds()].sort(), ["native-active", "sqlite-active"],
    "an unavailable native read is not evidence that the last-known working task ended");
  assert.equal(states.some(({ id, state }) => id === "native-active" && state === "working"), true);
  assert.equal(states.some(({ id, state }) => id === "sqlite-active" && state === "working"), true);
  assert.equal(states.some(({ id, state }) => id === "native-active" && state === "idle"), false);
  assert.equal(statusCalls, 3, "one provider-wide request may be in flight; polling never fans out per task");
});

test("slow transcript recovery cannot hold up current activity or start overlapping history sweeps", async (t) => {
  const events = new SseFixture();
  let statuses: Record<string, { type: string }> = { slow: { type: "busy" } };
  let historyReads = 0;
  let historyPending = false;
  const adapter = new OpenCodeAdapter({
    hostId: "host_1", activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000, nativeStatusPollIntervalMs: 20,
    fetch: async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
      if (url.pathname === "/session/status") return jsonResponse(statuses);
      if (url.pathname === "/session/slow/message") {
        historyReads += 1;
        historyPending = true;
        try {
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new Error("aborted"));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
          });
        } finally { historyPending = false; }
      }
      return new Response("not found", { status: 404 });
    },
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  await adapter.subscribe(null, event => {
    if (event.providerSessionId === "fast" && event.type === "session.status_changed") states.push(String(event.payload.state));
  });
  await waitFor(() => historyPending, "the slow transcript check should start");
  statuses = { slow: { type: "busy" }, fast: { type: "busy" } };
  await waitFor(() => states.includes("working"), "new native activity must arrive during the blocked history read");
  assert.equal(historyPending, true, "activity must not wait for a transcript timeout");
  statuses = { slow: { type: "busy" } };
  await waitFor(() => states.includes("idle"), "current native inactivity must also arrive during the blocked read");
  assert.equal(historyPending, true);
  assert.equal(adapter.hasActiveTurn("fast"), false);
  assert.equal(historyReads, 1, "fast polls must share the in-flight history sweep");
});

test("a slow native status snapshot cannot erase a newer SSE working state", async (t) => {
  const events = new SseFixture();
  let resolveStatus!: (response: Response) => void;
  let markStatusStarted!: () => void;
  const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname !== "/session/status") return new Response("not found", { status: 404 });
    return await new Promise<Response>((resolve, reject) => {
      resolveStatus = resolve;
      markStatusStarted();
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 20,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "sse-newer" && event.type === "session.status_changed") states.push(String(event.payload.state));
  });
  await statusStarted;
  events.push({ payload: { type: "session.status", properties: { sessionID: "sse-newer", status: { type: "busy" } } } });
  await waitFor(() => states.includes("working"), "the newer SSE working state must arrive while the HTTP snapshot is pending");

  resolveStatus(jsonResponse({}));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(states, ["working"], "the older empty HTTP snapshot must not emit a false idle after SSE");
  assert.equal(adapter.activeSessionIds().includes("sse-newer"), true);
});

test("a slow native status snapshot cannot resurrect work after a newer SSE idle", async (t) => {
  const events = new SseFixture();
  let resolveStatus!: (response: Response) => void;
  let markStatusStarted!: () => void;
  const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname !== "/session/status") return new Response("not found", { status: 404 });
    return await new Promise<Response>((resolve, reject) => {
      resolveStatus = resolve;
      markStatusStarted();
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 20,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "sse-newer" && event.type === "session.status_changed") states.push(String(event.payload.state));
  });
  await statusStarted;
  events.push({ payload: { type: "session.status", properties: { sessionID: "sse-newer", status: { type: "busy" } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "sse-newer", status: { type: "idle" } } } });
  await waitFor(() => states.length === 2, "the newer SSE busy-to-idle transition must finish while the HTTP snapshot is pending");

  resolveStatus(jsonResponse({ "sse-newer": { type: "busy" } }));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(states, ["working", "idle"], "the older busy HTTP snapshot must not resurrect the completed SSE state");
  assert.equal(adapter.activeSessionIds().includes("sse-newer"), false);
});

test("one slow external task cannot delay another task's working signal", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(["desktop-owned-a", "desktop-owned-b"])),
    activityPollIntervalMs: 60_000,
  });
  let releaseFirst = (): void => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstEntered = false;
  let secondEntered = false;
  t.after(() => {
    releaseFirst();
    return adapter.dispose();
  });
  await adapter.subscribe(null, async (event) => {
    if (event.type !== "session.status_changed" || event.payload.state !== "working") return;
    if (event.providerSessionId === "desktop-owned-a") {
      firstEntered = true;
      await firstGate;
    }
    if (event.providerSessionId === "desktop-owned-b") secondEntered = true;
  });

  await waitFor(() => firstEntered, "the first discovered task should enter its identity path");
  await waitFor(() => secondEntered, "a separate discovered task should publish without waiting for the first task");
  releaseFirst();
});

test("OpenCode startup discovery can exact-read a new active task without waiting on its own event", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/status") return jsonResponse({});
    if (url.pathname === "/session/desktop-owned") return jsonResponse({
      id: "desktop-owned",
      directory: "/external/project",
      title: "Desktop owned",
      time: { created: 1, updated: 2 },
    });
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(["desktop-owned"])),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let exactSession: RemoteSession | undefined;
  let exactReadMs = Number.POSITIVE_INFINITY;

  await adapter.subscribe(null, async (event) => {
    if (event.providerSessionId !== "desktop-owned"
      || event.type !== "session.status_changed"
      || event.payload.state !== "working") return;
    const startedAt = performance.now();
    exactSession = await adapter.getSession("desktop-owned");
    exactReadMs = performance.now() - startedAt;
  });
  await waitFor(() => exactSession !== undefined, "startup activity identity read must not deadlock its own event");

  assert.equal(exactSession?.state, "working");
  assert.ok(exactReadMs < 750, `exact identity read waited ${exactReadMs.toFixed(1)}ms on its own startup snapshot`);
});

test("OpenCode promptly discovers unknown external work after a quiet database change", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => requestUrl(input).pathname === "/global/event"
    ? events.response(init?.signal ?? undefined)
    : new Response("not found", { status: 404 });
  const reader = new SequenceActivityReader(new Set(), new Set(["new-external-task"]));
  let clockOffsetMs = 0;
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
    now: () => new Date(Date.now() + clockOffsetMs),
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  const catalogueSignals: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "new-external-task" && event.type === "session.status_changed") {
      states.push(String(event.payload.state));
    }
    if (event.providerSessionId === "new-external-task"
      && event.type === "session.updated"
      && event.payload.activityDiscovered === true) {
      catalogueSignals.push(event.providerSessionId);
    }
  });
  await waitFor(() => reader.reads === 1, "startup discovery must establish the initial throttle");
  // Advance the injected clock without adding a second of wall time: this
  // represents the ordinary case where OpenCode starts after Tethoq startup.
  clockOffsetMs = 5_000;

  const changedAt = performance.now();
  reader.signalChange();
  await waitFor(
    () => states.includes("working") && catalogueSignals.length === 1,
    "a quiet WAL change must materialize unknown external work",
  );

  const elapsedMs = performance.now() - changedAt;
  assert.ok(elapsedMs < 700, `external activity surfaced after ${elapsedMs.toFixed(1)}ms`);
  assert.deepEqual(states, ["working"]);
  assert.deepEqual(catalogueSignals, ["new-external-task"]);
  assert.deepEqual(reader.discoveryReads.slice(0, 2), [true, true]);
});

test("OpenCode retries an unavailable change discovery without another filesystem event", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => requestUrl(input).pathname === "/global/event"
    ? events.response(init?.signal ?? undefined)
    : new Response("not found", { status: 404 });
  const reader = new SequenceActivityReader(new Set(), undefined, new Set(["recovered-external-task"]));
  let nowMs = Date.now();
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
    activityDiscoveryIntervalMs: 250,
    now: () => new Date(nowMs),
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  const catalogueSignals: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "recovered-external-task" && event.type === "session.status_changed") {
      states.push(String(event.payload.state));
    }
    if (event.providerSessionId === "recovered-external-task"
      && event.type === "session.updated"
      && event.payload.activityDiscovered === true) {
      catalogueSignals.push(event.providerSessionId);
    }
  });
  await waitFor(() => reader.reads === 1, "startup discovery must finish before the changed commit");
  nowMs += 5_000;

  reader.signalChange();
  await waitFor(() => reader.reads >= 2, "the changed commit must trigger its first discovery attempt");
  assert.equal(states.length, 0, "an unavailable read is not working evidence");
  // The real retry timer still enforces the cadence checked below. Advance the
  // injected clock so a slightly early timer cannot produce an unrelated exact read.
  nowMs += 250;
  await waitFor(
    () => states.includes("working") && catalogueSignals.length === 1,
    "the pending discovery must retry without a second filesystem event",
  );

  assert.equal(reader.reads, 3);
  assert.deepEqual(reader.discoveryReads, [true, true, true]);
  assert.ok(
    reader.readStartedAt[2]! - reader.readStartedAt[1]! >= 200,
    "the unavailable helper read must retain the bounded discovery cadence",
  );
  assert.deepEqual(states, ["working"]);
  assert.deepEqual(catalogueSignals, ["recovered-external-task"]);
});

test("OpenCode coalesces a database write storm without an early exact read", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(
    new Set(["already-active"]),
    new Set(["already-active"]),
  );
  let releaseStartup = (): void => {};
  reader.nextReadGate = new Promise<void>((resolve) => { releaseStartup = resolve; });
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 60_000,
    activityDiscoveryIntervalMs: 300,
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, () => undefined);
  await waitFor(() => reader.reads === 1, "startup discovery must begin");

  for (let index = 0; index < 20; index += 1) reader.signalChange();
  await new Promise((resolve) => setTimeout(resolve, 130));
  releaseStartup();
  for (let index = 0; index < 20; index += 1) reader.signalChange();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reader.reads, 1, "a startup race must not trigger an early exact helper read");

  await waitFor(() => reader.reads >= 2, "the coalesced provider-wide read must run when discovery is due");
  assert.equal(reader.reads, 2);
  assert.deepEqual(reader.discoveryReads, [true, true], "no early exact read should precede due discovery");
  assert.ok(
    reader.readStartedAt[1]! - reader.readStartedAt[0]! >= 250,
    "continuous writes must not hot-loop the packaged SQLite helper",
  );
  assert.deepEqual([...(reader.candidateReads[1] ?? [])], ["already-active"]);
});

test("OpenCode does not settle an unproven turn when the server never emits session.idle", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/dispatched/prompt_async") return jsonResponse({});
    if (url.pathname === "/session/dispatched/message") return jsonResponse([]);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(new Set(), new Set());
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 5,
    activeTurnSettleMs: 50,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
  });
  await adapter.sendMessage("dispatched", { requestId: "req_1", content: "hello", attachments: [] });
  assert.equal(adapter.hasActiveTurn("dispatched"), true, "a dispatched turn is active");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(states, []);
  assert.equal(adapter.hasActiveTurn("dispatched"), true, "activity timeout alone cannot invent a terminal response");
});

test("OpenCode exposes live steering and persists a second prompt while work is active", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/session/ses_steer/prompt_async");
    assert.equal(init?.method, "POST");
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  assert.equal((await adapter.getCapabilities()).steering, true);
  const first = await adapter.sendMessage("ses_steer", { requestId: "first", content: "Keep working" });
  const steered = await adapter.steerMessage("ses_steer", { requestId: "steer", content: "Use DeepSeek V4 Flash subagents" });

  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0]?.messageID, bodies[1]?.messageID);
  assert.deepEqual(bodies[1]?.parts, [{ type: "text", text: "Use DeepSeek V4 Flash subagents" }]);
  assert.equal(steered.accepted, true);
  assert.notEqual(steered.providerTurnId, first.providerTurnId);
  assert.equal(adapter.hasActiveTurn("ses_steer"), true);
});

test("OpenCode clears the dispatch mark once activity disappearance confirms an exact terminal response", async (t) => {
  let promptId: string | undefined;
  let historyCalls = 0;
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/dispatched/prompt_async") return jsonResponse({});
    if (url.pathname === "/session/dispatched/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_dispatched",
          sessionID: "dispatched",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "dispatched_text", type: "text", text: "Done" }],
      }]);
    }
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(new Set(["dispatched"]), new Set());
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 5,
    activeTurnSettleMs: 5_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.completed") completions += 1;
  });
  const sent = await adapter.sendMessage("dispatched", { requestId: "req_2", content: "hello", attachments: [] });
  promptId = sent.providerTurnId;
  await waitFor(() => completions === 1, "two matching history reads must confirm the activity disappearance");
  assert.deepEqual(states, ["working"]);
  assert.ok(historyCalls >= 2);
  assert.equal(adapter.hasActiveTurn("dispatched"), false, "the exact finished turn need not wait for the long settle grace");
});

test("OpenCode session updates emit flat canonical relationship and model metadata", async () => {
  const info = {
    id: "child-live",
    projectID: "project-1",
    parentID: "root",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-live", variant: "high" },
    title: "Live child",
    time: { created: 1, updated: 2 },
  };
  const nativeEvents = [
    { payload: { type: "session.updated", properties: { info } } },
    { payload: { type: "session.updated", properties: { info, status: { type: "busy" } } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const updates: Array<Record<string, unknown>> = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.updated") updates.push({ providerSessionId: event.providerSessionId, ...event.payload });
  });
  const deadline = Date.now() + 1_000;
  while (updates.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(updates.slice(0, 2), [
    {
      providerSessionId: "child-live",
      title: "Live child",
      modelId: "openai/gpt-live",
      variantId: "high",
      reasoningEffort: "high",
      parentSessionId: "host_1/opencode/root",
      agentRole: "build",
    },
    {
      providerSessionId: "child-live",
      title: "Live child",
      modelId: "openai/gpt-live",
      variantId: "high",
      reasoningEffort: "high",
      parentSessionId: "host_1/opencode/root",
      agentRole: "build",
      state: "working",
    },
  ]);
  await adapter.dispose();
});

test("OpenCode message metadata publishes only real model changes and never mistakes a message id for a model", async (t) => {
  const infos = [
    { id: "assistant-a", sessionID: "session-model", role: "assistant", providerID: "opencode-go", modelID: "model-a", variant: "high", time: { created: 1 } },
    { id: "user-a", sessionID: "session-model", role: "user", model: { providerID: "opencode-go", modelID: "model-a", variant: "high" }, time: { created: 2 } },
    { id: "user-b", sessionID: "session-model", role: "user", model: { providerID: "opencode-go", modelID: "model-b", variant: "max" }, time: { created: 3 } },
    { id: "assistant-b", sessionID: "session-model", role: "assistant", providerID: "opencode-go", modelID: "model-b", variant: "max", time: { created: 4 } },
    { id: "assistant-a-again", sessionID: "session-model", role: "assistant", providerID: "opencode-go", modelID: "model-a", variant: "low", time: { created: 5 } },
    { id: "assistant-a-default", sessionID: "session-model", role: "assistant", providerID: "opencode-go", modelID: "model-a", time: { created: 6 } },
    // A replayed older snapshot must not regress the current A/default selection.
    { id: "late-old-b", sessionID: "session-model", role: "assistant", providerID: "opencode-go", modelID: "model-b", variant: "max", time: { created: 4 } },
    { id: "message-not-a-model", sessionID: "session-model", role: "assistant", providerID: "opencode-go", time: { created: 7 } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/session-model/message") {
      return jsonResponse([{ info: infos[3], parts: [] }]);
    }
    if (url.pathname === "/global/event" && !served) {
      served = true;
      return new Response(infos.map((info) => `data: ${JSON.stringify({ payload: { type: "message.updated", properties: { info } } })}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === "/global/event") {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new Error("aborted"));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return jsonResponse({});
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const updates: Array<Record<string, unknown>> = [];
  let starts = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.updated" && event.payload.modelId !== undefined) updates.push(event.payload);
    if (event.type === "message.started") starts += 1;
  });
  await waitFor(() => starts === infos.length, "every native message update should remain visible");

  assert.deepEqual(updates, [
    { modelId: "opencode-go/model-a", variantId: "high", reasoningEffort: "high" },
    { modelId: "opencode-go/model-b", variantId: "max", reasoningEffort: "max" },
    { modelId: "opencode-go/model-a", variantId: "low", reasoningEffort: "low" },
    { modelId: "opencode-go/model-a", variantId: "default", reasoningEffort: "default" },
  ]);
  await adapter.getMessages("session-model");
  assert.equal(updates.length, 4, "an older history refresh regressed the live model selection");
});

test("opening existing OpenCode history reports the latest persisted model selection", async (t) => {
  const history = [
    { info: { id: "latest", sessionID: "existing", role: "assistant", providerID: "opencode-go", modelID: "glm-5.3-flash", variant: "max", time: { created: 3, completed: 4 } }, parts: [] },
    { info: { id: "old", sessionID: "existing", role: "assistant", providerID: "opencode-go", modelID: "deepseek-v4-pro", variant: "high", time: { created: 1, completed: 2 } }, parts: [] },
  ];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/existing/message") return jsonResponse(history);
    if (url.pathname === "/global/event") {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new Error("aborted"));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return jsonResponse({});
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });
  t.after(() => adapter.dispose());
  const updates: Array<Record<string, unknown>> = [];
  await adapter.subscribe(null, (event) => { if (event.type === "session.updated") updates.push(event.payload); });

  await adapter.getMessages("existing");

  assert.deepEqual(updates, [{ modelId: "opencode-go/glm-5.3-flash", variantId: "max", reasoningEffort: "max" }]);
});

test("OpenCode part snapshots stream as incremental deltas keyed by part", async () => {
  const part = (text: string) => ({
    id: "prt_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "text",
    text,
  });
  // OpenCode republishes the whole part on every update. Forwarding those
  // snapshots as chunks made an accumulating consumer repeat the answer.
  const nativeEvents = [
    { payload: { type: "message.part.updated", properties: { part: part("Hello") } } },
    { payload: { type: "message.part.updated", properties: { part: part("Hello world") } } },
    { payload: { type: "message.part.updated", properties: { part: part("Hello world again") } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const deltas: Array<Record<string, unknown>> = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.delta") deltas.push({ providerSessionId: event.providerSessionId, ...event.payload });
  });
  const deadline = Date.now() + 1_000;
  while (deltas.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(deltas, [
    { providerSessionId: "ses_1", text: "Hello", partType: "text", partId: "prt_1", messageId: "msg_1" },
    { providerSessionId: "ses_1", text: " world", partType: "text", partId: "prt_1", messageId: "msg_1" },
    { providerSessionId: "ses_1", text: " again", partType: "text", partId: "prt_1", messageId: "msg_1" },
  ]);
  await adapter.dispose();
});

test("live OpenCode edit, write, and run events expose what changed and what ran", async () => {
  const nativeEvents = [{
    payload: { type: "message.part.updated", properties: { part: {
      id: "edit_live", messageID: "assistant_tools", sessionID: "ses_tools", type: "tool", tool: "edit",
      state: { status: "completed", input: { filePath: "C:\\work\\src\\app.ts", oldString: "old", newString: "new" }, output: "Edit applied successfully." },
    } } },
  }, {
    payload: { type: "message.part.updated", properties: { part: {
      id: "write_live", messageID: "assistant_tools", sessionID: "ses_tools", type: "tool", tool: "write",
      state: { status: "completed", input: { filePath: "C:\\work\\notes.md", content: "Release ready" }, output: "Wrote file successfully." },
    } } },
  }, {
    payload: { type: "message.part.updated", properties: { part: {
      id: "run_live", messageID: "assistant_tools", sessionID: "ses_tools", type: "tool", tool: "bash",
      state: { status: "completed", input: { command: "npm test", workdir: "C:\\work" }, output: "12 tests passed" },
    } } },
  }, {
    payload: { type: "message.part.updated", properties: { part: {
      id: "failed_live", messageID: "assistant_tools", sessionID: "ses_tools", type: "tool", tool: "bash",
      state: { status: "error", input: { command: "npm run missing", workdir: "C:\\work" }, output: "Missing script: missing" },
    } } },
  }, {
    payload: { type: "message.part.updated", properties: { part: {
      id: "eyes_failed_live", messageID: "assistant_tools", sessionID: "ses_tools", type: "tool", tool: "uar_mesh_ask_eyes",
      state: { status: "error", input: { question: "What is visible?" }, output: "429 quota exhausted key=req_private C:\\private\\session" },
    } } },
  }];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const toolEvents: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "tool.completed") toolEvents.push(event);
  });
  const deadline = Date.now() + 1_000;
  while (toolEvents.length < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(toolEvents.slice(0, 4).map(({ payload }) => ({ name: payload.name, output: payload.output, status: payload.status })), [{
    name: "Edit C:\\work\\src\\app.ts",
    output: "File: C:\\work\\src\\app.ts\n\nReplaced:\nold\n\nWith:\nnew",
    status: "completed",
  }, {
    name: "Write C:\\work\\notes.md",
    output: "File: C:\\work\\notes.md\n\nWritten content:\nRelease ready",
    status: "completed",
  }, {
    name: "Run npm test",
    output: "Command: npm test\n\nWorking directory: C:\\work\n\nResult:\n12 tests passed",
    status: "completed",
  }, {
    name: "Run npm run missing",
    output: "Command: npm run missing\n\nWorking directory: C:\\work\n\nResult:\nMissing script: missing",
    status: "failed",
  }]);
  const eyesFailure = toolEvents[4];
  assert.match(String(eyesFailure?.payload.output), /usage limit was reached or it is temporarily rate-limited/u);
  assert.doesNotMatch(JSON.stringify(eyesFailure), /req_private|private\\\\session/u);
  assert.equal(eyesFailure?.nativeEvent, undefined, "raw failed EYES provider data must stop at the adapter boundary");
  await adapter.dispose();
});

test("live OpenCode thinking arrives as part deltas, not as the part announcement", async () => {
  // OpenCode announces a part with an empty body and then streams the body itself as
  // message.part.delta, appending each chunk to the named field - this is exactly what
  // its own client does. Handling only the announcement built a reasoning row that
  // stayed blank for the whole turn and filled in only when history reloaded, which is
  // how live thinking came to read as a permanent "Thinking...".
  const nativeEvents = [
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_r", messageID: "msg_r", sessionID: "ses_r", type: "reasoning", text: "" } } } },
    { payload: { type: "message.part.delta", properties: { sessionID: "ses_r", messageID: "msg_r", partID: "prt_r", field: "text", delta: "Checking" } } },
    { payload: { type: "message.part.delta", properties: { sessionID: "ses_r", messageID: "msg_r", partID: "prt_r", field: "text", delta: " the adapter" } } },
    // A chunk for a part that was never announced has no row to belong to, and guessing
    // would append a thought to an answer.
    { payload: { type: "message.part.delta", properties: { sessionID: "ses_r", messageID: "msg_r", partID: "prt_unknown", field: "text", delta: "orphan" } } },
    // Fields other than the body (a tool's own metadata) are not transcript text.
    { payload: { type: "message.part.delta", properties: { sessionID: "ses_r", messageID: "msg_r", partID: "prt_r", field: "metadata", delta: "ignored" } } },
    // The closing announcement repeats the whole part; it must diff to nothing rather
    // than send the finished thought a second time.
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_r", messageID: "msg_r", sessionID: "ses_r", type: "reasoning", text: "Checking the adapter" } } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const deltas: Array<Record<string, unknown>> = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.delta") deltas.push({ providerSessionId: event.providerSessionId, ...event.payload });
  });
  const deadline = Date.now() + 1_000;
  while (deltas.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(deltas, [
    { providerSessionId: "ses_r", text: "Checking", partType: "reasoning", partId: "prt_r", messageId: "msg_r" },
    { providerSessionId: "ses_r", text: " the adapter", partType: "reasoning", partId: "prt_r", messageId: "msg_r" },
  ]);
  await adapter.dispose();
});

test("a rewritten OpenCode part resends its text instead of appending a fragment", async () => {
  const nativeEvents = [
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_2", messageID: "msg_2", sessionID: "ses_2", type: "reasoning", text: "First plan" } } } },
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_2", messageID: "msg_2", sessionID: "ses_2", type: "reasoning", text: "A different plan" } } } },
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_2", messageID: "msg_2", sessionID: "ses_2", type: "reasoning", text: "A different plan" } } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const deltas: string[] = [];
  const replaced: boolean[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type !== "message.delta") return;
    deltas.push(String(event.payload.text));
    replaced.push(event.payload.replace === true);
  });
  const deadline = Date.now() + 1_000;
  while (deltas.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // The replacement is sent whole and flagged, and an unchanged republish emits nothing.
  assert.deepEqual(deltas, ["First plan", "A different plan"]);
  assert.deepEqual(replaced, [false, true]);
  await adapter.dispose();
});

test("the prompt's own part updates never stream back as assistant text", async () => {
  const nativeEvents = [
    { payload: { type: "message.updated", properties: { info: { id: "msg_user", sessionID: "ses_3", role: "user" } } } },
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_user", messageID: "msg_user", sessionID: "ses_3", type: "text", text: "Summarise the repository" } } } },
    { payload: { type: "message.updated", properties: { info: { id: "msg_reply", sessionID: "ses_3", role: "assistant" } } } },
    { payload: { type: "message.part.updated", properties: { part: { id: "prt_reply", messageID: "msg_reply", sessionID: "ses_3", type: "text", text: "It is a monorepo." } } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const deltas: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.delta") deltas.push(String(event.payload.text));
  });
  const deadline = Date.now() + 1_000;
  while (deltas.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(deltas, ["It is a monorepo."]);
  await adapter.dispose();
});

test("OpenCode emits file activity only for a named non-empty patch part", async () => {
  const nativeEvents = [
    // OpenCode uses session.diff as current diff/revert state and publishes an
    // empty reset as soon as a turn starts. Neither shape is an edit action.
    { payload: { type: "session.diff", properties: { sessionID: "ses_files", diff: [] } } },
    { payload: { type: "session.diff", properties: { sessionID: "ses_files", diff: [{ file: "stale.ts", before: "", after: "" }] } } },
    // These workspace-global notifications cannot be attributed to this chat.
    { payload: { type: "file.watcher.updated", properties: { file: "watched.ts", event: "change" } } },
    { payload: { type: "file.edited", properties: { file: "edited.ts" } } },
    { payload: { type: "message.part.updated", properties: { part: {
      id: "patch_empty", messageID: "assistant_files", sessionID: "ses_files", type: "patch", hash: "empty", files: [],
    } } } },
    { payload: { type: "message.part.updated", properties: { part: {
      id: "patch_named", messageID: "assistant_files", sessionID: "ses_files", type: "patch", hash: "named", files: ["src/named.ts"],
    } } } },
  ];
  let served = false;
  const fetchLike: FetchLike = async (_input, init) => {
    if (!served) {
      served = true;
      return new Response(nativeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new Error("aborted"));
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  const changes: Array<{ readonly sessionId?: string; readonly files: unknown }> = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "file.changed") changes.push({
      ...(event.providerSessionId !== undefined ? { sessionId: event.providerSessionId } : {}),
      files: event.payload.files,
    });
  });
  const deadline = Date.now() + 1_000;
  while (changes.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(changes, [{ sessionId: "ses_files", files: ["src/named.ts"] }]);
  await adapter.dispose();
});

test("OpenCode session listing merges every project because an unscoped list only returns the global one", async () => {
  const requested: (string | null)[] = [];
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") {
      return jsonResponse([
        { id: "global", worktree: "/" },
        { id: "37b4", worktree: "C:\example-repo" },
        { id: "0af1", worktree: "C:\ExampleProject" },
      ]);
    }
    if (url.pathname === "/session") {
      const directory = url.searchParams.get("directory");
      requested.push(directory);
      if (directory === "C:\example-repo") {
        return jsonResponse([{ id: "ses_cli", directory: "C:\example-repo", title: "cli", time: { created: 1, updated: 3 } }]);
      }
      if (directory === "C:\ExampleProject") {
        return jsonResponse([{ id: "ses_example", directory: "C:\ExampleProject", title: "example", time: { created: 3, updated: 2 } }]);
      }
      return jsonResponse([{ id: "ses_global", directory: "/", title: "global", time: { created: 2, updated: 1 } }]);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const page = await adapter.listSessions();

  const ids = page.sessions.map((session) => session.providerSessionId);
  assert.deepEqual(ids, ["ses_cli", "ses_example", "ses_global"]);
  // The global project is the unscoped list; "/" is never sent as a directory.
  assert.equal(requested.filter((entry) => entry === null).length, 1);
  assert.ok(requested.includes("C:\example-repo"));
  assert.ok(!requested.includes("/"));

  const createdAscending = await adapter.listSessions({ sortKey: "created_at", sortDirection: "asc" });
  assert.deepEqual(createdAscending.sessions.map((session) => session.providerSessionId), ["ses_cli", "ses_global", "ses_example"]);
  await adapter.dispose();
});

test("OpenCode session listing keeps other projects when one project cannot be read", async () => {
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") {
      return jsonResponse([{ id: "global", worktree: "/" }, { id: "37b4", worktree: "C:\example-repo" }, { id: "bad", worktree: "C:\broken" }]);
    }
    if (url.pathname === "/session") {
      const directory = url.searchParams.get("directory");
      if (directory === "C:\broken") return new Response("boom", { status: 500 });
      if (directory === "C:\example-repo") {
        return jsonResponse([{ id: "ses_cli", directory: "C:\example-repo", title: "cli", time: { created: 3, updated: 3 } }]);
      }
      return jsonResponse([{ id: "ses_global", directory: "/", title: "global", time: { created: 1, updated: 1 } }]);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const page = await adapter.listSessions();

  assert.deepEqual(page.sessions.map((session) => session.providerSessionId).sort(), ["ses_cli", "ses_global"]);
  await adapter.dispose();
});

test("OpenCode session listing still throws when the primary list fails so cached sessions survive", async () => {
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") return jsonResponse([{ id: "global", worktree: "/" }]);
    if (url.pathname === "/session") return new Response("down", { status: 503 });
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  await assert.rejects(async () => await adapter.listSessions());
  await adapter.dispose();
});

test("OpenCode session listing honours a pinned directory instead of walking projects", async () => {
  const requested: (string | null)[] = [];
  let projectCalls = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") {
      projectCalls += 1;
      return jsonResponse([{ id: "global", worktree: "/" }, { id: "other", worktree: "C:\ExampleProject" }]);
    }
    if (url.pathname === "/session") {
      requested.push(url.searchParams.get("directory"));
      return jsonResponse([{ id: "ses_pinned", directory: "C:\example-repo", title: "pinned", time: { created: 1, updated: 1 } }]);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", directory: "C:\example-repo", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

const page = await adapter.listSessions();

  assert.equal(projectCalls, 0);
  assert.deepEqual(requested, ["C:\example-repo"]);
  assert.equal(page.sessions.length, 1);
  await adapter.dispose();
});

test("OpenCode explicit working-directory listing queries that directory even when project discovery omits it", async () => {
  const hiddenDirectory = "C:\\Users\\test\\Documents\\hidden-global";
  const requested: (string | null)[] = [];
  let projectCalls = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") {
      projectCalls += 1;
      return jsonResponse([{ id: "global", worktree: "/" }]);
    }
    if (url.pathname === "/session") {
      const directory = url.searchParams.get("directory");
      requested.push(directory);
      return directory === hiddenDirectory
        ? jsonResponse([{ id: "ses_hidden", directory: hiddenDirectory, title: "hidden", time: { created: 1, updated: 1 } }])
        : jsonResponse([]);
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const page = await adapter.listSessions({ workingDirectory: hiddenDirectory });

  assert.equal(projectCalls, 0);
  assert.deepEqual(requested, [hiddenDirectory]);
  assert.deepEqual(page.sessions.map((session) => session.providerSessionId), ["ses_hidden"]);
  await adapter.dispose();
});

test("OpenCode list and get expose only the currently reported retry notice", async () => {
  const retryAt = 1_760_000_030_000;
  let statuses: Record<string, unknown> = {
    ses_retry: {
      type: "retry",
      attempt: 1,
      message: "Raw retry https://opencode.ai/workspace/private",
      action: { message: "Go limit reached. Try again after reset. request_id=req_private trace_123456789 https://opencode.ai/workspace/private" },
      next: retryAt,
    },
  };
  const nativeSession = {
    id: "ses_retry",
    directory: "/workspace/project",
    title: "Retrying",
    time: { created: 1, updated: 2 },
  };
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/status") return jsonResponse(statuses);
    if (url.pathname === "/session/ses_retry") return jsonResponse(nativeSession);
    if (url.pathname === "/session") return jsonResponse([nativeSession]);
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    directory: "/workspace/project",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const page = await adapter.listSessions();
  const session = await adapter.getSession("ses_retry");
  const expected = {
    kind: "retry",
    message: "Go limit reached. Try again after reset.",
    retryAt: new Date(retryAt).toISOString(),
  };
  assert.deepEqual(page.sessions[0]?.providerStatus, expected);
  assert.deepEqual(session.providerStatus, expected);
  assert.doesNotMatch(JSON.stringify(session.providerStatus), /opencode\.ai/u);
  assert.doesNotMatch(JSON.stringify(session.providerStatus), /req_private|trace_123456789/u);

  statuses = {};
  const afterRestart = await adapter.getSession("ses_retry");
  assert.equal(afterRestart.providerStatus, undefined, "a restarted server with no retry must not inherit stale status");
  await adapter.dispose();
});

class SseFixture {
  readonly #encoder = new TextEncoder();
  #queue: Uint8Array[] = [];
  #pendingPull: ((chunk: Uint8Array) => void) | undefined;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  public response(signal?: AbortSignal): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
        signal?.addEventListener("abort", () => {
          if (this.#controller !== controller) return;
          this.#controller = undefined;
          this.#pendingPull = undefined;
          try { controller.close(); } catch {}
        }, { once: true });
      },
      pull: (controller) => {
        const chunk = this.#queue.shift();
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          return;
        }
        this.#pendingPull = (next) => controller.enqueue(next);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  public push(value: unknown): void {
    const chunk = this.#encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const pending = this.#pendingPull;
    if (pending !== undefined) {
      this.#pendingPull = undefined;
      pending(chunk);
    } else {
      this.#queue.push(chunk);
    }
  }

  public fail(error = new Error("event stream disconnected")): void {
    const controller = this.#controller;
    this.#controller = undefined;
    this.#pendingPull = undefined;
    controller?.error(error);
  }

  public close(): void {
    const controller = this.#controller;
    this.#controller = undefined;
    this.#pendingPull = undefined;
    controller?.close();
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${message}`);
}

test("OpenCode reconnect uses each project's runner truth instead of unfinished rows from the lost process", async (t) => {
  const events = new SseFixture();
  const directoryA = "C:/project a";
  const directoryB = "C:/project b";
  const scopes: Array<string | null> = [];
  const adapter = new NativeOpenCodeAdapter({
    hostId: "scoped-reconnect", activityReader: new SequenceActivityReader(new Set(["orphan"])),
    activityPollIntervalMs: 60_000, nativeStatusPollIntervalMs: 60_000,
    fetch: async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
      if (url.pathname === "/session/status") {
        const directory = url.searchParams.get("directory");
        scopes.push(directory);
        return jsonResponse(directory === directoryB ? { running: { type: "busy" } } : {});
      }
      return new Response(null, { status: 404 });
    },
  });
  t.after(() => adapter.dispose());
  const observed: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { observed.push(event); });
  for (const [sessionID, directory] of [["orphan", directoryA], ["running", directoryB]]) {
    events.push({ directory, payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
  }
  await waitFor(() => adapter.hasActiveTurn("running"), "project B's live status");
  events.fail();
  await waitFor(() => observed.some((event) => event.type === "provider.disconnected"), "stream disconnect");
  events.push({ payload: { type: "server.connected", properties: {} } });
  await waitFor(() => observed.some((event) => event.providerSessionId === "orphan" && event.payload.state === "idle"), "the lost runner must settle despite its orphaned SQLite assistant");
  assert.ok(scopes.includes(directoryA) && scopes.includes(directoryB));
  assert.equal(adapter.hasActiveTurn("running"), true);
  assert.equal(adapter.hasActiveTurn("orphan"), false);
  const disconnectIndex = observed.findIndex((event) => event.type === "provider.disconnected");
  assert.equal(observed.slice(disconnectIndex).some((event) => event.providerSessionId === "orphan" && event.payload.state === "working"), false);
});

test("OpenCode coalesces simultaneous task status reads in the same directory", async (t) => {
  let statusReads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter = new NativeOpenCodeAdapter({ hostId: "coalesced-directory", fetch: async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/status") {
      assert.equal(url.searchParams.get("directory"), "C:/shared project");
      statusReads += 1;
      await gate;
      return jsonResponse({});
    }
    return jsonResponse({ id: url.pathname.split("/")[2], directory: "C:/shared project", time: { created: 1, updated: 2 } });
  } });
  t.after(() => { release(); return adapter.dispose(); });
  const reads = Promise.all(Array.from({ length: 20 }, (_, index) => adapter.getSession(`task_${index}`)));
  await waitFor(() => statusReads > 0, "status lookup");
  assert.equal(statusReads, 1, "a shared project must not create twenty status requests");
  release();
  assert.equal((await reads).length, 20);
  assert.equal(statusReads, 1);
});

test("OpenCode keeps polling the project of a running task discovered only by its scoped status map", async (t) => {
  const events = new SseFixture();
  let projectPolls = 0;
  const adapter = new NativeOpenCodeAdapter({ hostId: "scoped-discovery", nativeStatusPollIntervalMs: 20,
    fetch: async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
      if (url.pathname === "/session/selected") return jsonResponse({ id: "selected", directory: "C:/project" });
      if (url.pathname === "/session/status") {
        if (url.searchParams.get("directory") !== "C:/project") return jsonResponse({});
        projectPolls += 1;
        return jsonResponse({ unseen: { type: "busy" } });
      }
      return new Response(null, { status: 404 });
    },
  });
  t.after(() => adapter.dispose());
  await adapter.getSession("selected");
  const states: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "unseen" && event.type === "session.status_changed") states.push(event.payload.state);
  });
  await waitFor(() => projectPolls >= 3, "later polls must retain the discovered task's scope");
  assert.equal(adapter.hasActiveTurn("unseen"), true);
  assert.equal(states.includes("idle"), false);
});

test("OpenCode marks every active task disconnected before the provider and restores from fresh reconnect truth", async (t) => {
  const events = new SseFixture();
  let statusCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/status") {
      statusCalls += 1;
      return jsonResponse({ "still-working": { type: "busy" } });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(), new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const observed: ProviderEvent[] = [];
  await adapter.subscribe(null, (event) => { observed.push(event); });

  events.push({ payload: { type: "session.status", properties: { sessionID: "still-working", status: { type: "busy" } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "now-idle", status: { type: "busy" } } } });
  await waitFor(() => adapter.activeSessionIds().length === 2, "both initial native tasks must be active");

  events.fail();
  await waitFor(() => observed.some((event) => event.type === "provider.disconnected"), "the broken SSE feed must publish provider disconnect");
  const providerDisconnectIndex = observed.findIndex((event) => event.type === "provider.disconnected");
  for (const sessionId of ["still-working", "now-idle"]) {
    const sessionDisconnectIndex = observed.findIndex((event) => event.providerSessionId === sessionId
      && event.type === "session.status_changed" && event.payload.state === "disconnected");
    assert.ok(sessionDisconnectIndex >= 0 && sessionDisconnectIndex < providerDisconnectIndex,
      `${sessionId} must become disconnected before the Bridge unsubscribes from its provider`);
  }
  assert.deepEqual(adapter.activeSessionIds(), [], "transport loss must suppress stale active claims");
  assert.deepEqual([...adapter.activeSessionIds({ includeDisconnected: true })].sort(), ["now-idle", "still-working"],
    "server handoff must preserve unresolved turns while their event feed is disconnected");
  assert.equal(observed.some((event) => event.type === "agent.completed"
    || event.type === "agent.interrupted" || event.type === "agent.error"), false,
  "disconnect must not invent any terminal outcome");

  // The next stream is established after the bounded reconnect backoff. The
  // event may be queued before its Response exists; SseFixture delivers it to
  // that new stream as soon as it subscribes.
  events.push({ payload: { type: "server.connected", properties: {} } });
  await waitFor(() => statusCalls === 1, "reconnect must force one fresh provider-wide status read");
  await waitFor(() => observed.some((event) => event.providerSessionId === "still-working"
    && event.type === "session.status_changed" && event.payload.state === "working"),
  "the still-busy task must be restored");
  await waitFor(() => observed.some((event) => event.providerSessionId === "now-idle"
    && event.type === "session.status_changed" && event.payload.state === "idle"),
  "a task omitted by the authoritative reconnect snapshot must become idle");
  assert.deepEqual(adapter.activeSessionIds(), ["still-working"]);
  assert.deepEqual(adapter.activeSessionIds({ includeDisconnected: true }), ["still-working"],
    "confirmed idle tasks no longer need their previous server kept alive");
});

test("a delayed reconnect snapshot cannot overwrite a newer live session state", async (t) => {
  const events = new SseFixture();
  let resolveReconnectStatus!: (response: Response) => void;
  let markReconnectStatusStarted!: () => void;
  const reconnectStatusStarted = new Promise<void>((resolve) => { markReconnectStatusStarted = resolve; });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/status") {
      markReconnectStatusStarted();
      return await new Promise<Response>((resolve, reject) => {
        resolveReconnectStatus = resolve;
        const abort = (): void => reject(new Error("aborted"));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set(), new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.providerSessionId === "race" && event.type === "session.status_changed") states.push(String(event.payload.state));
  });
  events.push({ payload: { type: "session.status", properties: { sessionID: "race", status: { type: "busy" } } } });
  await waitFor(() => adapter.activeSessionIds().includes("race"), "the initial task must be active");

  events.fail();
  await waitFor(() => states.includes("disconnected"), "the task must show transport uncertainty");
  events.push({ payload: { type: "server.connected", properties: {} } });
  await reconnectStatusStarted;
  events.push({ payload: { type: "session.status", properties: { sessionID: "race", status: { type: "idle" } } } });
  await waitFor(() => states.at(-1) === "idle", "newer SSE idle must win while reconnect history is pending");

  resolveReconnectStatus(jsonResponse({ race: { type: "busy" } }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(states, ["working", "disconnected", "idle"]);
  assert.equal(adapter.activeSessionIds().includes("race"), false);
});

test("a clean OpenCode event-stream EOF is a disconnect, not completion", async (t) => {
  const events = new SseFixture();
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: async (input, init) => requestUrl(input).pathname === "/global/event"
      ? events.response(init?.signal ?? undefined)
      : new Response("not found", { status: 404 }),
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const eventTypes: string[] = [];
  await adapter.subscribe(null, (event) => { eventTypes.push(event.type); });
  events.push({ payload: { type: "session.status", properties: { sessionID: "clean-eof", status: { type: "busy" } } } });
  await waitFor(() => adapter.activeSessionIds().includes("clean-eof"), "the clean-EOF task must start active");

  events.close();
  await waitFor(() => eventTypes.includes("provider.disconnected"), "clean EOF must publish disconnect");
  assert.deepEqual(eventTypes.slice(-2), ["session.status_changed", "provider.disconnected"]);
  assert.equal(eventTypes.some((type) => type === "agent.completed" || type === "agent.interrupted" || type === "agent.error"), false);
});

test("an active OpenCode steer becomes the owned follow-up and settles on its own final answer", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_live_steer/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_live_steer/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_live_steer/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });

  const first = await adapter.sendMessage("ses_live_steer", { requestId: "first", content: "Keep working" });
  const steered = await adapter.steerMessage("ses_live_steer", { requestId: "steer", content: "Use the faster subagent" });
  assert.ok(first.providerTurnId);
  assert.ok(steered.providerTurnId);

  events.push({ payload: { type: "message.updated", properties: { info: {
    id: steered.providerTurnId,
    sessionID: "ses_live_steer",
    role: "user",
    time: { created: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_before_steer",
    sessionID: "ses_live_steer",
    role: "assistant",
    parentID: first.providerTurnId,
    finish: "stop",
    time: { created: 1, completed: 3 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_after_steer",
    sessionID: "ses_live_steer",
    role: "assistant",
    parentID: steered.providerTurnId,
    finish: "stop",
    time: { created: 4, completed: 5 },
  } } } });
  history.push(
    { info: { id: "assistant_before_steer", sessionID: "ses_live_steer", role: "assistant", parentID: first.providerTurnId, finish: "stop", time: { created: 1, completed: 3 } }, parts: [{ id: "before", type: "text", text: "Finishing the current step" }] },
    { info: { id: "assistant_after_steer", sessionID: "ses_live_steer", role: "assistant", parentID: steered.providerTurnId, finish: "stop", time: { created: 4, completed: 5 } }, parts: [{ id: "after", type: "text", text: "Applied the steering instruction" }] },
  );
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_live_steer" } } });

  await waitFor(() => completions === 1, "the steered follow-up must complete from its own persisted final answer");
  assert.equal(adapter.hasActiveTurn("ses_live_steer"), false);
  assert.equal(abortCalls, 0, "live steering must not be mistaken for a runaway continuation");
});

test("cursorless OpenCode listing reloads once when live status invalidates its first fetch", async (t) => {
  const events = new SseFixture();
  const nativeSession = {
    id: "ses_list_race",
    directory: "/workspace/project",
    title: "List race",
    time: { created: 1, updated: 2 },
  };
  let sessionReads = 0;
  let statusReads = 0;
  let resolveFirstSession: ((response: Response) => void) | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/status") {
      statusReads += 1;
      return jsonResponse({
        ses_list_race: statusReads === 1
          ? { type: "retry", message: "Stale retry", next: 1_760_000_030_000 }
          : { type: "idle" },
      });
    }
    if (url.pathname === "/session") {
      sessionReads += 1;
      if (sessionReads === 1) {
        return await new Promise<Response>((resolve) => { resolveFirstSession = resolve; });
      }
      return jsonResponse([nativeSession]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    directory: "/workspace/project",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => {
    resolveFirstSession?.(jsonResponse([nativeSession]));
    return adapter.dispose();
  });
  let clearSeen = false;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && event.payload.providerStatus === null) clearSeen = true;
  });

  const listing = adapter.listSessions();
  await waitFor(() => sessionReads === 1 && statusReads === 1, "the first list/status reads must both be in flight");
  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_list_race",
    status: { type: "idle" },
  } } });
  await waitFor(() => clearSeen, "the live clear must invalidate the first list generation");
  assert.ok(resolveFirstSession);
  resolveFirstSession(jsonResponse([nativeSession]));

  const page = await listing;
  assert.equal(sessionReads, 2, "the invalidated cursorless fetch is reloaded exactly once");
  assert.equal(statusReads, 2);
  assert.equal(page.sessions[0]?.state, "idle");
  assert.equal(page.sessions[0]?.providerStatus, undefined);
});

test("OpenCode live retry status is sanitized and the next busy status clears it", async (t) => {
  const events = new SseFixture();
  let promptCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname.endsWith("/prompt_async")) promptCalls += 1;
    if (url.pathname.endsWith("/abort")) abortCalls += 1;
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const statuses: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed") statuses.push(event.payload);
  });

  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_retry_live",
    status: {
      type: "retry",
      attempt: 2,
      message: "Raw detail https://opencode.ai/workspace/private",
      action: { message: "  Go limit reached\nRetrying shortly. https://opencode.ai/workspace/private " },
      next: 1_760_000_030_000,
    },
  } } });
  await waitFor(() => statuses.length === 1, "retry status must be forwarded");
  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_retry_live",
    status: { type: "busy" },
  } } });
  await waitFor(() => statuses.length === 2, "busy status must clear retry metadata");

  assert.deepEqual(statuses, [{
    state: "working",
    providerStatus: {
      kind: "retry",
      message: "Go limit reached Retrying shortly.",
      retryAt: "2025-10-09T08:53:50.000Z",
    },
  }, {
    state: "working",
    providerStatus: null,
  }]);
  assert.equal(promptCalls, 0, "retry lifecycle must never dispatch another prompt");
  assert.equal(abortCalls, 0, "retry lifecycle must never abort the provider");
});

test("manual interrupt turns abort cleanup into one interruption and leaves the next prompt healthy", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let promptCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_manual_interrupt/prompt_async") {
      promptCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_manual_interrupt/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_manual_interrupt/abort") {
      abortCalls += 1;
      events.push({ payload: { type: "session.error", properties: {
        sessionID: "ses_manual_interrupt",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      } } });
      events.push({ payload: { type: "session.status", properties: {
        sessionID: "ses_manual_interrupt",
        status: { type: "idle" },
      } } });
      events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_manual_interrupt" } } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const interruptions: unknown[] = [];
  const completions: unknown[] = [];
  const errors: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.interrupted") interruptions.push(event.payload);
    if (event.type === "agent.completed") completions.push(event.payload);
    if (event.type === "agent.error") errors.push(event.payload);
  });

  const first = await adapter.sendMessage("ses_manual_interrupt", { requestId: "first", content: "First" });
  await adapter.interrupt("ses_manual_interrupt");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(interruptions, [{ providerStatus: null, turnId: first.providerTurnId }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, []);
  assert.equal(promptCalls, 1);
  assert.equal(abortCalls, 1);
  assert.equal(adapter.hasActiveTurn("ses_manual_interrupt"), false);

  const successor = await adapter.sendMessage("ses_manual_interrupt", { requestId: "second", content: "Second" });
  assert.ok(successor.providerTurnId);
  const terminal = {
    info: {
      id: "assistant_after_interrupt",
      sessionID: "ses_manual_interrupt",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 3, completed: 4 },
    },
    parts: [{ id: "after_interrupt_text", type: "text", text: "Done" }],
  };
  history.push(terminal);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: successor.providerTurnId,
    sessionID: "ses_manual_interrupt",
    role: "user",
    time: { created: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: terminal.info } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_manual_interrupt" } } });
  await waitFor(() => completions.length === 1, "the prompt after an interruption must complete normally");

  assert.equal(promptCalls, 2);
  assert.equal(abortCalls, 1);
  assert.equal(interruptions.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, [{ providerStatus: null }]);
  assert.equal(adapter.hasActiveTurn("ses_manual_interrupt"), false);
});

test("sequential duplicate stops share one abort while a genuine successor can still be stopped", async (t) => {
  const events = new SseFixture();
  let promptCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_sequential_stop/prompt_async") {
      promptCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_sequential_stop/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const interruptions: unknown[] = [];
  const errors: unknown[] = [];
  const completions: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.interrupted") interruptions.push(event.payload);
    if (event.type === "agent.error") errors.push(event.payload);
    if (event.type === "agent.completed") completions.push(event.payload);
  });

  await adapter.sendMessage("ses_sequential_stop", { requestId: "first", content: "First" });
  await adapter.interrupt("ses_sequential_stop");
  await adapter.interrupt("ses_sequential_stop");

  assert.equal(abortCalls, 1, "a completed Stop remains idempotent for the stopped generation");
  assert.equal(interruptions.length, 1);
  assert.equal(adapter.hasActiveTurn("ses_sequential_stop"), false);

  await adapter.sendMessage("ses_sequential_stop", { requestId: "successor", content: "Second" });
  assert.equal(adapter.hasActiveTurn("ses_sequential_stop"), true);
  await adapter.interrupt("ses_sequential_stop");

  assert.equal(promptCalls, 2);
  assert.equal(abortCalls, 2, "a new active prompt is a distinct generation and remains stoppable");
  assert.equal(interruptions.length, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, []);
  assert.equal(adapter.hasActiveTurn("ses_sequential_stop"), false);
});

test("manual Stop settles from native abort evidence without waiting for a stalled HTTP body", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let cancelledResponse = false;
  let releaseResponse!: () => void;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/abort")) {
      abortCalls += 1;
      return await new Promise<Response>((resolve, reject) => {
        const cleanup = setTimeout(() => {
          events.push({ payload: { type: "session.error", properties: { sessionID: "ses_slow_abort",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } });
          events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_slow_abort" } } });
        }, 70);
        const aborted = () => { cancelledResponse = true; clearTimeout(cleanup); reject(new Error("abort response cancelled after native cleanup")); };
        init?.signal?.addEventListener("abort", aborted, { once: true });
        releaseResponse = () => { clearTimeout(cleanup); init?.signal?.removeEventListener("abort", aborted); resolve(jsonResponse({})); };
      });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ directory: "C:/fixture", hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()), activityPollIntervalMs: 60_000 });
  t.after(async () => { releaseResponse?.(); await adapter.dispose(); });
  const observed: ProviderEvent[] = [];
  await adapter.subscribe(null, event => { observed.push(event); });
  await adapter.sendMessage("ses_slow_abort", { requestId: "slow-abort", content: "Run a long tool and keep working" });
  const started = performance.now();
  const stopping = adapter.interrupt("ses_slow_abort");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stopping, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Stop exceeded 3 seconds despite confirmed native cancellation")), 3000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
  assert.ok(performance.now() - started < 3000);
  assert.equal(cancelledResponse, true, "the unused HTTP response must be cancelled, not leaked");
  assert.equal(adapter.hasActiveTurn("ses_slow_abort"), false);
  assert.equal(observed.filter(event => event.type === "agent.interrupted").length, 1);
  assert.equal(observed.filter(event => event.type === "agent.error").length, 0);
  await adapter.interrupt("ses_slow_abort");
  assert.equal(abortCalls, 1);
});

for (const blockedRequest of ["prompt response", "receipt read"]) test(`Stop does not wait behind a ${blockedRequest} after OpenCode already saved the instruction`, async (t) => {
  const events = new SseFixture();
  let promptBody: Record<string, unknown> | undefined;
  let releaseResponse!: () => void;
  let responseCancelled = false;
  let abortCalls = 0;
  let receiptReads = 0;
  const stall = (signal: AbortSignal | null | undefined) => new Promise<Response>((resolve, reject) => {
    const aborted = () => { responseCancelled = true; reject(new Error("prompt response cancelled")); };
    signal?.addEventListener("abort", aborted, { once: true });
    releaseResponse = () => { signal?.removeEventListener("abort", aborted); resolve(new Response(null, { status: 204 })); };
  });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname.endsWith("/prompt_async")) {
      promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      events.push({ payload: { type: "session.status", properties: { sessionID: "ses_pending_stop", status: { type: "busy" } } } });
      return blockedRequest === "prompt response" ? await stall(init?.signal) : new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/message/") && promptBody) {
      if (++receiptReads === 1 && blockedRequest === "receipt read") return await stall(init?.signal);
      return jsonResponse({ info: { id: promptBody.messageID, sessionID: "ses_pending_stop", role: "user" }, parts: promptBody.parts });
    }
    if (url.pathname.endsWith("/abort")) {
      abortCalls++;
      events.push({ payload: { type: "session.error", properties: { sessionID: "ses_pending_stop",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } });
      events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_pending_stop" } } });
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new NativeOpenCodeAdapter({ directory: "C:/fixture", hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()), activityPollIntervalMs: 60_000 });
  t.after(async () => { releaseResponse?.(); await adapter.dispose(); });
  await adapter.subscribe(null, () => undefined);
  const sending = adapter.sendMessage("ses_pending_stop", { requestId: "pending-stop", content: "Run a long tool" });
  await waitFor(() => releaseResponse !== undefined, "native prompt accepted while HTTP is pending");
  const stopping = adapter.interrupt("ses_pending_stop");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stopping, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Stop waited over 3 seconds behind prompt delivery")), 3000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
  assert.equal((await sending).accepted, true, "the exact saved instruction must remain accepted");
  assert.equal(responseCancelled, true);
  assert.equal(abortCalls, 1);
  assert.equal(adapter.hasActiveTurn("ses_pending_stop"), false);
});

test("a delayed abort cleanup confirms a manual stop whose HTTP response disconnected", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_delayed_manual_cleanup/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_delayed_manual_cleanup/abort") {
      abortCalls += 1;
      setTimeout(() => events.push({ payload: { type: "session.error", properties: {
        sessionID: "ses_delayed_manual_cleanup",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      } } }), 30);
      throw new TypeError("connection closed before the abort response");
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const interruptions: unknown[] = [];
  const errors: unknown[] = [];
  const completions: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.interrupted") interruptions.push(event.payload);
    if (event.type === "agent.error") errors.push(event.payload);
    if (event.type === "agent.completed") completions.push(event.payload);
  });

  const first = await adapter.sendMessage("ses_delayed_manual_cleanup", { requestId: "first", content: "First" });
  await adapter.interrupt("ses_delayed_manual_cleanup");

  assert.equal(abortCalls, 1);
  assert.deepEqual(interruptions, [{ providerStatus: null, turnId: first.providerTurnId }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, []);
  assert.equal(adapter.hasActiveTurn("ses_delayed_manual_cleanup"), false);
});

test("a genuine manual abort failure rejects after its bounded cleanup grace and remains retryable", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let failuresRemaining = 1;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_manual_abort_failure/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_manual_abort_failure/abort") {
      abortCalls += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new TypeError("abort endpoint unavailable");
      }
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const interruptions: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.interrupted") interruptions.push(event.payload);
  });
  await adapter.sendMessage("ses_manual_abort_failure", { requestId: "first", content: "First" });

  const startedAt = Date.now();
  await assert.rejects(() => adapter.interrupt("ses_manual_abort_failure"), /abort endpoint unavailable/);
  assert.ok(Date.now() - startedAt >= 200, "a rejected response must leave a bounded window for delayed native cleanup");
  assert.equal(abortCalls, 1);
  assert.deepEqual(interruptions, []);
  assert.equal(adapter.hasActiveTurn("ses_manual_abort_failure"), true);

  await adapter.interrupt("ses_manual_abort_failure");
  assert.equal(abortCalls, 2, "retiring an unconfirmed generation must leave a real retry possible");
  assert.equal(interruptions.length, 1);
  assert.equal(adapter.hasActiveTurn("ses_manual_abort_failure"), false);
});

test("genuine provider error stays failed through trailing idle cleanup and the next prompt completes", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let promptCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_error_cleanup/prompt_async") {
      promptCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_error_cleanup/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_error_cleanup/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const errors: unknown[] = [];
  const completions: unknown[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.error") errors.push(event.payload);
    if (event.type === "agent.completed") completions.push(event.payload);
  });

  await adapter.sendMessage("ses_error_cleanup", { requestId: "first", content: "Fail" });
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_error_cleanup",
    error: { name: "APIError", data: { message: "Provider failed", isRetryable: false } },
  } } });
  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_error_cleanup",
    status: { type: "idle" },
  } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_error_cleanup" } } });
  await waitFor(() => errors.length === 1, "the genuine error must be emitted");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal((errors[0] as { providerStatus?: unknown }).providerStatus, null);
  assert.deepEqual(completions, [], "idle cleanup must not turn failure into success");
  assert.equal(adapter.hasActiveTurn("ses_error_cleanup"), false);

  const successor = await adapter.sendMessage("ses_error_cleanup", { requestId: "second", content: "Recover" });
  assert.ok(successor.providerTurnId);
  const terminal = {
    info: {
      id: "assistant_after_error",
      sessionID: "ses_error_cleanup",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 3, completed: 4 },
    },
    parts: [{ id: "after_error_text", type: "text", text: "Recovered" }],
  };
  history.push(terminal);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: successor.providerTurnId,
    sessionID: "ses_error_cleanup",
    role: "user",
    time: { created: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: terminal.info } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_error_cleanup" } } });
  await waitFor(() => completions.length === 1, "the prompt after a failure must complete normally");

  assert.equal(promptCalls, 2);
  assert.equal(abortCalls, 0);
  assert.equal(errors.length, 1);
  assert.deepEqual(completions, [{ providerStatus: null }]);
  assert.equal(adapter.hasActiveTurn("ses_error_cleanup"), false);
});

test("an idle queued ahead of a continuing tool cannot finish the prompt", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let toolObserved = false;
  let finalVisible = false;
  let historyCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_idle_tool_race/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_idle_tool_race/message") {
      historyCalls += 1;
      const first = {
        info: {
          id: "assistant_tool_step",
          sessionID: "ses_idle_tool_race",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: toolObserved
          ? [{ id: "queued_tool", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }]
          : [{ id: "premature_text", type: "text", text: "Checking" }],
      };
      const final = {
        info: {
          id: "assistant_after_tool",
          sessionID: "ses_idle_tool_race",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 3, completed: 4 },
        },
        parts: [{ id: "final_text", type: "text", text: "Done" }],
      };
      return jsonResponse(finalVisible ? [first, final] : [first]);
    }
    if (url.pathname === "/session/ses_idle_tool_race/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "tool.completed") toolObserved = true;
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_idle_tool_race", { requestId: "idle_tool_race", content: "Use the tool" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_tool_step",
    sessionID: "ses_idle_tool_race",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  // OpenCode can queue the idle before publishing the tool part that explains
  // why this stop is only an intermediate step. One matching history read is
  // therefore not enough terminal authority.
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_idle_tool_race" } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "queued_tool",
    messageID: "assistant_tool_step",
    sessionID: "ses_idle_tool_race",
    type: "tool",
    tool: "bash",
    state: { status: "completed", output: "ok" },
  } } } });

  await waitFor(() => toolObserved, "the queued tool evidence must be processed");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(completions, 0, "the premature idle must not pump the next request");
  assert.equal(adapter.hasActiveTurn("ses_idle_tool_race"), true);
  assert.equal(abortCalls, 0);

  finalVisible = true;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_after_tool",
    sessionID: "ses_idle_tool_race",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 3, completed: 4 },
  } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_idle_tool_race" } } });
  await waitFor(() => completions === 1, "the later exact no-tool terminal must complete once");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(started, ["assistant_tool_step", "assistant_after_tool"]);
  assert.equal(completions, 1);
  assert.equal(adapter.hasActiveTurn("ses_idle_tool_race"), false);
  assert.equal(abortCalls, 0);
  assert.ok(historyCalls >= 2, "terminality requires two matching history reads after the queued tool race");
});

test("activity disappearance and its timeout cannot settle incomplete owned prompts", async (t) => {
  const events = new SseFixture();
  const promptIds = new Map<string, string>();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_activity_drop/message") return jsonResponse([{
      info: {
        id: "assistant_tool_only",
        sessionID: "ses_activity_drop",
        role: "assistant",
        parentID: promptIds.get("ses_activity_drop"),
        finish: "stop",
        time: { created: 1, completed: 2 },
      },
      parts: [{ id: "activity_tool", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }],
    }]);
    if (url.pathname === "/session/ses_activity_timeout/message") return jsonResponse([{
      info: {
        id: "assistant_incomplete",
        sessionID: "ses_activity_timeout",
        role: "assistant",
        parentID: promptIds.get("ses_activity_timeout"),
        time: { created: 3 },
      },
      parts: [{ id: "partial_reasoning", type: "reasoning", text: "Still working" }],
    }]);
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(
    new Set(["ses_activity_drop"]),
    new Set(["ses_activity_drop"]),
    new Set(),
  );
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: reader,
    activityPollIntervalMs: 5,
    activeTurnSettleMs: 30,
  });
  t.after(() => adapter.dispose());

  const dropped = await adapter.sendMessage("ses_activity_drop", { requestId: "activity_drop", content: "Use a tool" });
  const timed = await adapter.sendMessage("ses_activity_timeout", { requestId: "activity_timeout", content: "Take your time" });
  assert.ok(dropped.providerTurnId);
  assert.ok(timed.providerTurnId);
  promptIds.set("ses_activity_drop", dropped.providerTurnId);
  promptIds.set("ses_activity_timeout", timed.providerTurnId);

  const idleStates: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && event.payload.state === "idle" && event.providerSessionId !== undefined) {
      idleStates.push(event.providerSessionId);
    }
    if (event.type === "agent.completed") completions += 1;
  });
  await waitFor(() => reader.reads >= 6, "the activity disappearance and settle timeout must both elapse");
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(idleStates, [], "activity alone cannot publish a pump-authoritative idle for an owned prompt");
  assert.equal(completions, 0);
  assert.equal(adapter.hasActiveTurn("ses_activity_drop"), true, "a tool-bearing step is still continuing");
  assert.equal(adapter.hasActiveTurn("ses_activity_timeout"), true, "a fixed timeout cannot invent a terminal response");
});

test("a delayed guard abort cannot erase or complete a concurrently starting successor", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  const sequence: string[] = [];
  let promptCalls = 0;
  let abortCalls = 0;
  let resolveAbort!: (response: Response) => void;
  const abortResponse = new Promise<Response>((resolve) => { resolveAbort = resolve; });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_abort_send_race/prompt_async") {
      promptCalls += 1;
      sequence.push(`prompt:${promptCalls}`);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_abort_send_race/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_abort_send_race/abort") {
      abortCalls += 1;
      sequence.push("abort:start");
      const response = await abortResponse;
      sequence.push("abort:end");
      return response;
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") {
      completions += 1;
      sequence.push("completed");
    }
  });

  const first = await adapter.sendMessage("ses_abort_send_race", { requestId: "first", content: "First" });
  assert.ok(first.providerTurnId);
  history.push({
    info: {
      id: "assistant_first_terminal",
      sessionID: "ses_abort_send_race",
      role: "assistant",
      parentID: first.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "first_text", type: "text", text: "Done" }],
  });
  history.push({
    info: {
      id: "assistant_runaway",
      sessionID: "ses_abort_send_race",
      role: "assistant",
      parentID: first.providerTurnId,
      time: { created: 3 },
    },
    parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
  });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first_terminal",
    sessionID: "ses_abort_send_race",
    role: "assistant",
    parentID: first.providerTurnId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_abort_send_race",
    role: "assistant",
    parentID: first.providerTurnId,
    time: { created: 3 },
  } } } });
  await waitFor(() => abortCalls === 1, "the guard abort must be in flight");

  const successorPromise = adapter.sendMessage("ses_abort_send_race", { requestId: "successor", content: "Second" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  resolveAbort(jsonResponse({}));
  const successor = await successorPromise;
  assert.ok(successor.providerTurnId);
  await waitFor(() => sequence.includes("abort:end"), "the guard abort must return");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const successorDispatch = sequence.indexOf("prompt:2");
  assert.notEqual(successorDispatch, -1);
  for (let index = successorDispatch + 1; index < sequence.length; index += 1) {
    assert.notEqual(sequence[index], "completed", "old guard completion must never land after the successor dispatch");
  }
  assert.equal(adapter.hasActiveTurn("ses_abort_send_race"), true, "the accepted successor must retain ownership");

  const completionsBeforeSuccessor = completions;
  history.push({
    info: {
      id: "assistant_successor",
      sessionID: "ses_abort_send_race",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 4, completed: 5 },
    },
    parts: [{ id: "successor_text", type: "text", text: "Second done" }],
  });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_successor",
    sessionID: "ses_abort_send_race",
    role: "assistant",
    parentID: successor.providerTurnId,
    finish: "stop",
    time: { created: 4, completed: 5 },
  } } } });
  // No cleanup arrived during the bounded barrier, so the successor's first
  // exact terminal idle is genuine.
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_abort_send_race" } } });
  await waitFor(() => completions === completionsBeforeSuccessor + 1, "the successor must complete under its own terminal evidence");
  assert.equal(adapter.hasActiveTurn("ses_abort_send_race"), false);
});

test("an ambiguous guard abort does not turn its later abort event into an agent error", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_ambiguous_abort/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_ambiguous_abort/message") return jsonResponse([
      {
        info: {
          id: "assistant_terminal",
          sessionID: "ses_ambiguous_abort",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "terminal_text", type: "text", text: "Done" }],
      },
      {
        info: {
          id: "assistant_runaway",
          sessionID: "ses_ambiguous_abort",
          role: "assistant",
          parentID: promptId,
          time: { created: 3 },
        },
        parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
      },
    ]);
    if (url.pathname === "/session/ses_ambiguous_abort/abort") {
      abortCalls += 1;
      throw new TypeError("connection closed before the abort response");
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const errors: string[] = [];
  const completions: Array<string | undefined> = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.error") {
      const error = event.payload.error;
      errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
    }
    if (event.type === "agent.completed") {
      completions.push(typeof event.payload.completionReason === "string" ? event.payload.completionReason : undefined);
    }
  });

  const sent = await adapter.sendMessage("ses_ambiguous_abort", { requestId: "ambiguous_abort", content: "First" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_terminal",
    sessionID: "ses_ambiguous_abort",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_ambiguous_abort",
    role: "assistant",
    parentID: promptId,
    time: { created: 3 },
  } } } });
  await waitFor(() => abortCalls === 1, "the ambiguous guard abort must be attempted");
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_ambiguous_abort",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  await waitFor(() => completions.length === 1, "the native abort error confirms that the ambiguous request acted");

  assert.deepEqual(errors, [], "guard-induced abort cleanup is not a user-facing Agent error");
  assert.deepEqual(completions, ["runaway_guard"]);
  assert.equal(adapter.hasActiveTurn("ses_ambiguous_abort"), false);
});

test("post-attempt live output retires ambiguous abort-error suppression", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_ambiguous_live_output/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_ambiguous_live_output/message") return jsonResponse([
      {
        info: {
          id: "assistant_terminal",
          sessionID: "ses_ambiguous_live_output",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "terminal_text", type: "text", text: "Done" }],
      },
      {
        info: {
          id: "assistant_continued",
          sessionID: "ses_ambiguous_live_output",
          role: "assistant",
          parentID: promptId,
          time: { created: 3 },
        },
        parts: [{ id: "continued_text", type: "text", text: "Still running" }],
      },
    ]);
    if (url.pathname === "/session/ses_ambiguous_live_output/abort") {
      abortCalls += 1;
      throw new TypeError("connection closed before the abort response");
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const errors: string[] = [];
  const deltas: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.error") {
      const error = event.payload.error;
      errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
    }
    if (event.type === "message.delta" && typeof event.payload.text === "string") deltas.push(event.payload.text);
  });

  const sent = await adapter.sendMessage("ses_ambiguous_live_output", { requestId: "ambiguous_live", content: "First" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_terminal",
    sessionID: "ses_ambiguous_live_output",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_continued",
    sessionID: "ses_ambiguous_live_output",
    role: "assistant",
    parentID: promptId,
    time: { created: 3 },
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "continued_text",
    messageID: "assistant_continued",
    sessionID: "ses_ambiguous_live_output",
    type: "text",
    text: "Still running",
  } } } });
  await waitFor(() => abortCalls === 1 && deltas.includes("Still running"), "the failed abort must be followed by new live output");

  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_ambiguous_live_output",
    error: { name: "MessageAbortedError", data: { message: "later unrelated abort" } },
  } } });
  await waitFor(() => errors.length === 1, "post-attempt output makes the later abort-shaped error genuine");
  assert.deepEqual(errors, ["MessageAbortedError"]);
  assert.equal(adapter.hasActiveTurn("ses_ambiguous_live_output"), false);
});

test("a genuine session error releases the owned prompt", async (t) => {
  const events = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_real_error/prompt_async") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const errors: string[] = [];
  const readableErrors: JsonObject[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type !== "agent.error") return;
    readableErrors.push(event.payload);
    const error = event.payload.error;
    errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
  });

  await adapter.sendMessage("ses_real_error", { requestId: "real_error", content: "Fail normally" });
  assert.equal(adapter.hasActiveTurn("ses_real_error"), true);
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_real_error",
    error: { name: "APIError", data: { message: "provider failed", isRetryable: false,
      responseBody: "private transport", metadata: { url: "https://private.example" } } },
  } } });
  await waitFor(() => errors.length === 1, "the genuine provider error must remain visible");

  assert.deepEqual(errors, ["APIError"]);
  assert.equal(readableErrors[0]?.message, "provider failed");
  assert.doesNotMatch(JSON.stringify(readableErrors), /private|responseBody|metadata/);
  assert.equal(adapter.hasActiveTurn("ses_real_error"), false, "a failed prompt cannot keep the queue held forever");
});

test("a successor message boundary preserves its genuine failed status", async (t) => {
  const events = new SseFixture();
  let firstPromptId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_successor_failed/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_successor_failed/message") return jsonResponse([
      {
        info: {
          id: "assistant_first",
          sessionID: "ses_successor_failed",
          role: "assistant",
          parentID: firstPromptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "first_text", type: "text", text: "Done" }],
      },
      {
        info: {
          id: "assistant_runaway",
          sessionID: "ses_successor_failed",
          role: "assistant",
          parentID: firstPromptId,
          time: { created: 3 },
        },
        parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
      },
    ]);
    if (url.pathname === "/session/ses_successor_failed/abort") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.completed") completions += 1;
  });

  const first = await adapter.sendMessage("ses_successor_failed", { requestId: "first", content: "First" });
  firstPromptId = first.providerTurnId;
  assert.ok(firstPromptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_successor_failed",
    role: "assistant",
    parentID: firstPromptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_successor_failed",
    role: "assistant",
    parentID: firstPromptId,
    time: { created: 3 },
  } } } });
  await waitFor(() => completions === 1, "the first prompt must establish the guard tombstone");

  const successor = await adapter.sendMessage("ses_successor_failed", { requestId: "successor", content: "Second" });
  assert.ok(successor.providerTurnId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: successor.providerTurnId,
    sessionID: "ses_successor_failed",
    role: "user",
    time: { created: 4 },
  } } } });
  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_successor_failed",
    status: { type: "busy" },
  } } });
  events.push({ payload: { type: "session.status", properties: {
    sessionID: "ses_successor_failed",
    status: { type: "error" },
  } } });
  await waitFor(() => states.includes("failed"), "the successor's genuine failed status must be forwarded");

  assert.deepEqual(states.slice(-2), ["working", "failed"]);
  assert.equal(completions, 1, "a failed successor is not a second successful completion");
  assert.equal(adapter.hasActiveTurn("ses_successor_failed"), false);
});

test("activity becoming unavailable still asks exact history to finish the owned prompt", async (t) => {
  const events = new SseFixture();
  let activityReads = 0;
  let historyCalls = 0;
  let promptId: string | undefined;
  const activityReader: OpenCodeActivityReader = {
    async readWorkingSessionIds(): Promise<ReadonlySet<string>> {
      activityReads += 1;
      if (activityReads === 1) return new Set(["ses_activity_unavailable"]);
      throw new Error("activity source temporarily unavailable");
    },
    close(): void {},
  };
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_activity_unavailable/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_activity_unavailable/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_activity_terminal",
          sessionID: "ses_activity_unavailable",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "activity_terminal_text", type: "text", text: "Done" }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader,
    activityPollIntervalMs: 5,
    activeTurnSettleMs: 25,
  });
  t.after(() => adapter.dispose());

  const sent = await adapter.sendMessage("ses_activity_unavailable", { requestId: "activity_unavailable", content: "Finish normally" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  const states: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.completed") completions += 1;
  });

  await waitFor(() => completions === 1, "unavailable activity must still trigger exact-history confirmation");
  assert.deepEqual(states, ["working"]);
  assert.ok(activityReads >= 2);
  assert.ok(historyCalls >= 2, "completion still requires two matching persisted reads");
  assert.equal(adapter.hasActiveTurn("ses_activity_unavailable"), false);
});

test("after an empty guard barrier the successor's first idle is genuine", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_idle_order/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_idle_order/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_guard_idle_order/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });

  const first = await adapter.sendMessage("ses_guard_idle_order", { requestId: "first", content: "First" });
  assert.ok(first.providerTurnId);
  history.push({
    info: {
      id: "assistant_first",
      sessionID: "ses_guard_idle_order",
      role: "assistant",
      parentID: first.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "first_text", type: "text", text: "Done" }],
  });
  history.push({
    info: {
      id: "assistant_runaway",
      sessionID: "ses_guard_idle_order",
      role: "assistant",
      parentID: first.providerTurnId,
      time: { created: 3 },
    },
    parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
  });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_guard_idle_order",
    role: "assistant",
    parentID: first.providerTurnId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_guard_idle_order",
    role: "assistant",
    parentID: first.providerTurnId,
    time: { created: 3 },
  } } } });
  await waitFor(() => abortCalls === 1 && completions === 1, "the first prompt must establish the successful guard");

  const successor = await adapter.sendMessage("ses_guard_idle_order", { requestId: "successor", content: "Second" });
  assert.ok(successor.providerTurnId);
  history.push({
    info: {
      id: "assistant_successor",
      sessionID: "ses_guard_idle_order",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 4, completed: 5 },
    },
    parts: [{ id: "successor_text", type: "text", text: "Second done" }],
  });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_successor",
    sessionID: "ses_guard_idle_order",
    role: "assistant",
    parentID: successor.providerTurnId,
    finish: "stop",
    time: { created: 4, completed: 5 },
  } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_idle_order" } } });
  await waitFor(() => completions === 2, "the successor's first idle must complete after cleanup timed out empty");
  assert.equal(adapter.hasActiveTurn("ses_guard_idle_order"), false);
});

test("guard abort errors stay quarantined only until the successor message boundary", async (t) => {
  const events = new SseFixture();
  let firstPromptId: string | undefined;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_error_once/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_error_once/message") return jsonResponse([
      {
        info: {
          id: "assistant_first",
          sessionID: "ses_guard_error_once",
          role: "assistant",
          parentID: firstPromptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "first_text", type: "text", text: "Done" }],
      },
      {
        info: {
          id: "assistant_runaway",
          sessionID: "ses_guard_error_once",
          role: "assistant",
          parentID: firstPromptId,
          time: { created: 3 },
        },
        parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
      },
    ]);
    if (url.pathname === "/session/ses_guard_error_once/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const errors: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.error") {
      const error = event.payload.error;
      errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
    }
    if (event.type === "agent.completed") completions += 1;
  });

  const first = await adapter.sendMessage("ses_guard_error_once", { requestId: "first", content: "First" });
  firstPromptId = first.providerTurnId;
  assert.ok(firstPromptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_guard_error_once",
    role: "assistant",
    parentID: firstPromptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_guard_error_once",
    role: "assistant",
    parentID: firstPromptId,
    time: { created: 3 },
  } } } });
  await waitFor(() => abortCalls === 1, "the guard must establish its cleanup barrier");

  const successorPromise = adapter.sendMessage("ses_guard_error_once", { requestId: "successor", content: "Second" });
  const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } };
  events.push({ payload: { type: "session.error", properties: { sessionID: "ses_guard_error_once", error: aborted } } });
  const successor = await successorPromise;
  assert.ok(successor.providerTurnId);
  assert.deepEqual(errors, []);
  assert.equal(adapter.hasActiveTurn("ses_guard_error_once"), true, "the one cleanup error cannot release the successor");

  // Cleanup is not reliably one-shot. Every abort-shaped event before the
  // provider acknowledges the new user message still belongs to the guard.
  events.push({ payload: { type: "session.error", properties: { sessionID: "ses_guard_error_once", error: aborted } } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(errors, []);
  assert.equal(adapter.hasActiveTurn("ses_guard_error_once"), true);

  events.push({ payload: { type: "message.updated", properties: { info: {
    id: successor.providerTurnId,
    sessionID: "ses_guard_error_once",
    role: "user",
    time: { created: 4 },
  } } } });
  events.push({ payload: { type: "session.error", properties: { sessionID: "ses_guard_error_once", error: aborted } } });
  await waitFor(() => errors.length === 1, "an abort error after the exact successor boundary must remain visible");
  assert.deepEqual(errors, ["MessageAbortedError"]);
  assert.equal(adapter.hasActiveTurn("ses_guard_error_once"), false, "the visible error releases owned state");
  assert.equal(completions, 1);
});

test("the runaway guard requires two history reads before suppressing a continuation", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_two_reads/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_two_reads/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_first",
          sessionID: "ses_guard_two_reads",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: historyCalls === 1
          ? [{ id: "first_text", type: "text", text: "Checking" }]
          : [{ id: "late_tool", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }],
      }]);
    }
    if (url.pathname === "/session/ses_guard_two_reads/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const deltas: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "message.delta" && typeof event.payload.text === "string") deltas.push(event.payload.text);
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_guard_two_reads", { requestId: "two_reads", content: "Use the tool if needed" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_guard_two_reads",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_legitimate_continuation",
    sessionID: "ses_guard_two_reads",
    role: "assistant",
    parentID: promptId,
    time: { created: 3 },
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "continuation_text",
    messageID: "assistant_legitimate_continuation",
    sessionID: "ses_guard_two_reads",
    type: "text",
    text: "The tool finished.",
  } } } });
  await waitFor(() => deltas.includes("The tool finished."), "the legitimate continuation must remain visible");

  assert.equal(historyCalls, 2, "the guard must re-read history after its quiet window");
  assert.equal(abortCalls, 0);
  assert.equal(completions, 0);
  assert.deepEqual(started, ["assistant_first", "assistant_legitimate_continuation"]);
  assert.equal(adapter.hasActiveTurn("ses_guard_two_reads"), true);
});

test("a guard with no cleanup signals lets the successor complete on one genuine idle", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_no_cleanup/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_no_cleanup/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_guard_no_cleanup/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  const errors: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
    if (event.type === "agent.error") errors.push(event.type);
  });

  const first = await adapter.sendMessage("ses_guard_no_cleanup", { requestId: "first", content: "First" });
  assert.ok(first.providerTurnId);
  const firstTerminal = {
    info: {
      id: "assistant_first",
      sessionID: "ses_guard_no_cleanup",
      role: "assistant",
      parentID: first.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "first_text", type: "text", text: "Done" }],
  };
  const suspicious = {
    info: {
      id: "assistant_suspicious",
      sessionID: "ses_guard_no_cleanup",
      role: "assistant",
      parentID: first.providerTurnId,
      time: { created: 3 },
    },
    parts: [{ id: "suspicious_text", type: "text", text: "Repeated" }],
  };
  history.push(firstTerminal, suspicious);
  events.push({ payload: { type: "message.updated", properties: { info: firstTerminal.info } } });
  events.push({ payload: { type: "message.updated", properties: { info: suspicious.info } } });
  await waitFor(() => abortCalls === 1, "the persisted suspicious response must trigger the guard");
  await waitFor(() => completions === 1, "the bounded barrier must finish even when cleanup emits nothing");
  // Some servers publish only the abort error after the 500ms empty-cleanup
  // fallback. It still belongs to the guarded generation and is not a user-
  // facing provider failure.
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_guard_no_cleanup",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(errors, []);
  assert.equal(completions, 1);

  const successor = await adapter.sendMessage("ses_guard_no_cleanup", { requestId: "successor", content: "Second" });
  assert.ok(successor.providerTurnId);
  // A successor has a new generation but has not produced anything yet. A lone
  // idle at this boundary is still delayed cleanup from the guarded runner; it
  // must not settle the successor before its own output exists.
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_no_cleanup" } } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(completions, 1);
  assert.equal(adapter.hasActiveTurn("ses_guard_no_cleanup"), true);
  const successorTerminal = {
    info: {
      id: "assistant_successor",
      sessionID: "ses_guard_no_cleanup",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 4, completed: 5 },
    },
    parts: [{ id: "successor_text", type: "text", text: "Second done" }],
  };
  history.push(successorTerminal);
  events.push({ payload: { type: "message.updated", properties: { info: successorTerminal.info } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_no_cleanup" } } });
  await waitFor(() => completions === 2, "the successor's sole idle must remain genuine after the empty cleanup barrier");

  assert.deepEqual(errors, []);
  assert.equal(adapter.hasActiveTurn("ses_guard_no_cleanup"), false);
});

test("an activity snapshot started before guard completion cannot resurrect the stopped turn", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let activityReads = 0;
  let resolveFirstRead!: (value: ReadonlySet<string>) => void;
  let firstReadResolved = false;
  const activityReader: OpenCodeActivityReader = {
    async readWorkingSessionIds(): Promise<ReadonlySet<string>> {
      activityReads += 1;
      if (activityReads !== 1) return new Set();
      return await new Promise<ReadonlySet<string>>((resolve) => {
        resolveFirstRead = (value) => {
          firstReadResolved = true;
          resolve(value);
        };
      });
    },
    close(): void {},
  };
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_activity_epoch/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_activity_epoch/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_guard_activity_epoch/abort") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader,
    activityPollIntervalMs: 10,
  });
  t.after(() => {
    if (!firstReadResolved) resolveFirstRead(new Set());
    return adapter.dispose();
  });
  let completions = 0;
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
  });
  await waitFor(() => activityReads === 1, "the pre-guard activity read must be in flight");

  const sent = await adapter.sendMessage("ses_guard_activity_epoch", { requestId: "guard_activity", content: "First" });
  assert.ok(sent.providerTurnId);
  const terminal = {
    info: {
      id: "assistant_first",
      sessionID: "ses_guard_activity_epoch",
      role: "assistant",
      parentID: sent.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "first_text", type: "text", text: "Done" }],
  };
  const suspicious = {
    info: {
      id: "assistant_suspicious",
      sessionID: "ses_guard_activity_epoch",
      role: "assistant",
      parentID: sent.providerTurnId,
      time: { created: 3 },
    },
    parts: [{ id: "suspicious_text", type: "text", text: "Repeated" }],
  };
  history.push(terminal, suspicious);
  events.push({ payload: { type: "message.updated", properties: { info: terminal.info } } });
  events.push({ payload: { type: "message.updated", properties: { info: suspicious.info } } });
  await waitFor(() => completions === 1, "the guard must complete while the database read is still pending");
  assert.equal(adapter.hasActiveTurn("ses_guard_activity_epoch"), false);

  resolveFirstRead(new Set(["ses_guard_activity_epoch"]));
  await waitFor(() => activityReads >= 2, "the stale activity result must be discarded and re-read");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(adapter.hasActiveTurn("ses_guard_activity_epoch"), false);
  assert.deepEqual(states, [], "the stale working snapshot must not repaint the completed guard generation");
});

test("late guard cleanup is quarantined while the successor starts", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  let promptCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_late_cleanup/prompt_async") {
      promptCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_guard_late_cleanup/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_guard_late_cleanup/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  const errors: string[] = [];
  const started: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
    if (event.type === "agent.error") errors.push(event.type);
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
  });

  const first = await adapter.sendMessage("ses_guard_late_cleanup", { requestId: "first", content: "First" });
  assert.ok(first.providerTurnId);
  const firstTerminal = {
    info: {
      id: "assistant_first",
      sessionID: "ses_guard_late_cleanup",
      role: "assistant",
      parentID: first.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "first_text", type: "text", text: "Done" }],
  };
  const suspicious = {
    info: {
      id: "assistant_suspicious",
      sessionID: "ses_guard_late_cleanup",
      role: "assistant",
      parentID: first.providerTurnId,
      time: { created: 3 },
    },
    parts: [{ id: "suspicious_text", type: "text", text: "Repeated" }],
  };
  history.push(firstTerminal, suspicious);
  events.push({ payload: { type: "message.updated", properties: { info: firstTerminal.info } } });
  events.push({ payload: { type: "message.updated", properties: { info: suspicious.info } } });
  await waitFor(() => abortCalls === 1, "the guard abort must finish before cleanup starts");

  const successorPromise = adapter.sendMessage("ses_guard_late_cleanup", { requestId: "successor", content: "Second" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(promptCalls, 2, "the successor must not wait on an arbitrary cleanup timer");
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_late_cleanup" } } });
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_guard_late_cleanup",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  const successor = await successorPromise;
  assert.ok(successor.providerTurnId);
  assert.equal(promptCalls, 2);
  assert.equal(completions, 1);
  assert.deepEqual(errors, []);

  const successorTerminal = {
    info: {
      id: "assistant_successor",
      sessionID: "ses_guard_late_cleanup",
      role: "assistant",
      parentID: successor.providerTurnId,
      finish: "stop",
      time: { created: 4, completed: 5 },
    },
    parts: [{ id: "successor_text", type: "text", text: "Second done" }],
  };
  history.push(successorTerminal);
  events.push({ payload: { type: "message.updated", properties: { info: successorTerminal.info } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_late_cleanup" } } });
  await waitFor(() => completions === 2, "cleanup must not settle or suppress the successor");

  assert.ok(started.includes("assistant_successor"));
  assert.deepEqual(errors, []);
  assert.equal(adapter.hasActiveTurn("ses_guard_late_cleanup"), false);
});

test("the runaway guard requires the suspicious assistant to exist in persisted history", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_missing_suspicious/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_missing_suspicious/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_first",
          sessionID: "ses_guard_missing_suspicious",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "first_text", type: "text", text: "Done" }],
      }]);
    }
    if (url.pathname === "/session/ses_guard_missing_suspicious/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const deltas: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "message.delta" && typeof event.payload.text === "string") deltas.push(event.payload.text);
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_guard_missing_suspicious", { requestId: "missing_suspicious", content: "First" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_guard_missing_suspicious",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_unpersisted",
    sessionID: "ses_guard_missing_suspicious",
    role: "assistant",
    parentID: promptId,
    time: { created: 3 },
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "unpersisted_text",
    messageID: "assistant_unpersisted",
    sessionID: "ses_guard_missing_suspicious",
    type: "text",
    text: "Still legitimate until persisted proof says otherwise.",
  } } } });
  await waitFor(() => deltas.length === 1, "an unpersisted suspicious response must fail open and remain visible");

  assert.ok(historyCalls >= 2);
  assert.equal(abortCalls, 0);
  assert.equal(completions, 0);
  assert.deepEqual(started, ["assistant_first", "assistant_unpersisted"]);
  assert.equal(adapter.hasActiveTurn("ses_guard_missing_suspicious"), true);
});

test("OpenCode waits for an actual no-tool continuation before aborting a runaway prompt", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let promptId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_loop/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_loop/message") return jsonResponse([
      {
        info: {
          id: "assistant_first",
          sessionID: "ses_loop",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: "part_first", type: "text", text: "What task?" }],
      },
      {
        info: {
          id: "assistant_runaway",
          sessionID: "ses_loop",
          role: "assistant",
          parentID: promptId,
          time: { created: 3 },
        },
        parts: [{ id: "part_runaway", type: "text", text: "What task, again?" }],
      },
    ]);
    if (url.pathname === "/session/ses_loop/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const completed: Array<string | undefined> = [];
  const errors: string[] = [];
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "agent.completed") completed.push(typeof event.payload.completionReason === "string" ? event.payload.completionReason : undefined);
    if (event.type === "agent.error") {
      const error = event.payload.error;
      errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
    }
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
  });
  const sent = await adapter.sendMessage("ses_loop", { requestId: "bridge_1", content: "do this task" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);

  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_loop",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  await waitFor(() => started.includes("assistant_first"), "the completed response must remain visible");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(abortCalls, 0, "a healthy terminal response is never aborted preemptively");
  assert.equal(completed.length, 0, "normal completion still belongs to session.idle");
  assert.equal(adapter.hasActiveTurn("ses_loop"), true);

  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway",
    sessionID: "ses_loop",
    role: "assistant",
    parentID: promptId,
    time: { created: 3 },
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "part_runaway",
    messageID: "assistant_runaway",
    sessionID: "ses_loop",
    type: "text",
    text: "What task, again?",
  } } } });
  await waitFor(() => abortCalls === 1, "the confirmed persisted runaway continuation must be stopped");
  await waitFor(() => completed.length === 1, "a confirmed guard stop must complete cleanly without waiting for cleanup noise");

  // `/abort` produces these native lifecycle events. They describe the guard's
  // own cleanup, not a failed answer. The generation quarantine absorbs every
  // one until a concrete newer prompt forms the provider-order boundary.
  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_loop", status: { type: "busy" } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_loop", status: { type: "idle" } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_loop" } } });
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_loop",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  // The quarantine is deliberately narrow: a structured non-abort provider
  // failure after cleanup remains visible.
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_loop",
    error: { name: "APIError", data: { message: "real provider failure", isRetryable: false } },
  } } });
  // More already-buffered output from the same bad parent is ignored without
  // issuing another abort.
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway_again",
    sessionID: "ses_loop",
    role: "assistant",
    parentID: promptId,
    time: { created: 4 },
  } } } });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(started, ["assistant_first"]);
  assert.deepEqual(errors, ["APIError"], "only the guard-induced abort error is suppressed");
  assert.deepEqual(states, []);
  assert.deepEqual(completed, ["runaway_guard"], "only the verified internal guard carries the authority marker");
  assert.equal(adapter.hasActiveTurn("ses_loop"), false);
  assert.equal(abortCalls, 1);
});

test("OpenCode settles an exact persisted no-tool response without waiting for session.idle", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_persisted_terminal/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_persisted_terminal/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_terminal",
          sessionID: "ses_persisted_terminal",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 10, completed: 20 },
        },
        parts: [{ id: "terminal_text", type: "text", text: "The focused checks passed." }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_persisted_terminal", { requestId: "persisted_terminal", content: "Run the checks" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_terminal",
    sessionID: "ses_persisted_terminal",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10, completed: 20 },
  } } } });

  await waitFor(() => completions === 1, "persisted terminal history must settle the turn without session.idle");
  assert.ok(historyCalls >= 2, "completion requires two matching persisted-history confirmations");
  assert.equal(adapter.hasActiveTurn("ses_persisted_terminal"), false);
});

for (const scenario of ["newer", "older", "missing-proof", "owned-successor"] as const) {
  test(`OpenCode external follow-up completion handles ${scenario} prompt ownership`, async (t) => {
    const events = new SseFixture();
    const sessionID = "external_follow_up";
    const promptTimes = new Map<string, number>([["external_user", scenario === "older" ? 5 : 20]]);
    let proofAvailable = scenario !== "missing-proof";
    let proofReads = 0;
    let completions = 0;
    let aborts = 0;
    const info = {
      id: "external_answer", sessionID, role: "assistant", parentID: "external_user",
      finish: "stop", time: { created: 25, completed: 30 },
    };
    const adapter = new OpenCodeAdapter({
      directory: "C:/fixture",
      hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", nativeStatusPollIntervalMs: 60_000,
      activityReader: new SequenceActivityReader(new Set()), activityPollIntervalMs: 60_000,
      fetch: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === "/global/event") return events.response(init?.signal ?? undefined);
        if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 });
        if (path.endsWith("/abort")) { aborts += 1; return jsonResponse(true); }
        if (path.endsWith("/message")) {
          // The reported stall ended without an answer or a continuing tool.
          return jsonResponse([{ info, parts: [{ type: "step-finish", reason: "stop" }] }]);
        }
        if (path.includes("/message/")) {
          proofReads += 1;
          const id = path.split("/").at(-1)!;
          const created = promptTimes.get(id);
          if (proofAvailable && created !== undefined) {
            return jsonResponse({ info: { id, sessionID, role: "user", time: { created } }, parts: [] });
          }
        }
        return new Response("not found", { status: 404 });
      },
    });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });
    const sent = await adapter.sendMessage(sessionID, { requestId: "owned_goal", content: "Continue the goal" });
    promptTimes.set(sent.providerTurnId!, 10);
    events.push({ payload: { type: "message.updated", properties: { info } } });
    await waitFor(() => proofReads >= 2, "an outside terminal response must check both persisted user prompts");

    if (scenario === "missing-proof") {
      assert.equal(completions, 0, "missing history is not proof of completion");
      assert.equal(adapter.hasActiveTurn(sessionID), true);
      proofAvailable = true;
    }
    if (scenario === "owned-successor") {
      const next = await adapter.sendMessage(sessionID, { requestId: "new_owned_goal", content: "A newer instruction" });
      promptTimes.set(next.providerTurnId!, 40);
    }
    if (scenario === "older" || scenario === "owned-successor") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(completions, 0, "an older answer must not settle newer owned work");
      assert.equal(adapter.hasActiveTurn(sessionID), true);
    } else {
      await waitFor(() => completions === 1, "a completed external follow-up must release the old dispatch mark");
      assert.equal(adapter.hasActiveTurn(sessionID), false);
      assert.ok(proofReads >= 4, "both quiet confirmations must verify successor ownership");
    }
    assert.equal(aborts, 0, "reconciling completion must not stop the provider");
  });
}

for (const successor of ["terminal", "running-tool", "newer-owned-prompt"] as const) {
  test(`OpenCode recovery follows a changed prompt while an older idle is pending: ${successor}`, async (t) => {
    const sessionID = "pending_idle_successor";
    const events = new SseFixture();
    const promptTimes = new Map<string, number>([["native_continuation", 30]]);
    let history: unknown[] = [];
    let pendingReads = 0;
    let tailReads = 0;
    let completions = 0;
    let aborts = 0;
    const adapter = new OpenCodeAdapter({
      directory: "C:/fixture",
      hostId: "host_1", baseUrl: "http://127.0.0.1:4096/",
      activityReader: new SequenceActivityReader(new Set()),
      activityPollIntervalMs: 60_000, nativeStatusPollIntervalMs: 20,
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
        if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
        if (url.pathname.endsWith("/abort")) { aborts += 1; return jsonResponse(true); }
        if (url.pathname === "/session/status") return jsonResponse({});
        if (url.pathname.endsWith("/message")) {
          if (url.searchParams.get("limit") === "2") tailReads += 1;
          else pendingReads += 1;
          return jsonResponse(history);
        }
        if (url.pathname.includes("/message/")) {
          const id = url.pathname.split("/").at(-1)!;
          const created = promptTimes.get(id);
          if (created !== undefined) return jsonResponse({ info: { id, role: "user", time: { created } }, parts: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });
    const sent = await adapter.sendMessage(sessionID, { requestId: "before_compaction", content: "Continue" });
    promptTimes.set(sent.providerTurnId!, 10);
    events.push({ payload: { type: "session.idle", properties: { sessionID } } });
    await waitFor(() => pendingReads > 0, "the old prompt must have an outstanding completion check");
    if (successor === "newer-owned-prompt") {
      const next = await adapter.sendMessage(sessionID, { requestId: "new_instruction", content: "New work" });
      promptTimes.set(next.providerTurnId!, 50);
      events.push({ payload: { type: "session.idle", properties: { sessionID } } });
    }
    // Auto-compaction/native continuation changes parentID. Its final SSE is
    // lost, and every message for the old dispatched parent is outside the tail.
    history = [{
      info: { id: "native_final", sessionID, role: "assistant", parentID: "native_continuation", finish: "stop", time: { created: 40, completed: 45 } },
      parts: successor === "running-tool"
        ? [{ type: "tool", tool: "bash", state: { status: "running" } }]
        : [{ type: "reasoning", text: "Checked", time: { start: 40, end: 42 } }, { type: "text", text: "Finished" }, { type: "step-finish", reason: "stop" }],
    }];
    const before = tailReads;
    await waitFor(() => tailReads > before, "a pending old idle must not exclude this task from tail recovery");
    if (successor === "terminal") {
      await waitFor(() => completions === 1, "the newer persisted final must settle the old dispatch ownership");
      assert.equal(adapter.hasActiveTurn(sessionID), false);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(completions, 0);
      assert.equal(adapter.hasActiveTurn(sessionID), true);
    }
    assert.equal(aborts, 0, "history recovery must not abort provider work");
  });
}

for (const origin of ["owned", "external", "recovered"] as const) {
  test(`OpenCode settles ${origin} terminal output despite persistent database and native busy`, async (t) => {
    const events = new SseFixture();
    const sessionID = `terminal_${origin}`;
    const reader = new SequenceActivityReader(new Set([sessionID]));
    let parentID = "external_user";
    let ready = false;
    let historyCalls = 0;
    let aborts = 0;
    const info = (): Record<string, unknown> => ({
      id: "terminal_answer", sessionID, role: "assistant", parentID,
      finish: "stop", time: { created: 10 },
    });
    const adapter = new OpenCodeAdapter({
      directory: "C:/fixture",
      hostId: "host_1", baseUrl: "http://127.0.0.1:4096/",
      activityReader: reader, activityPollIntervalMs: 20,
      nativeStatusPollIntervalMs: origin === "recovered" ? 20 : 60_000,
      fetch: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === "/global/event") return events.response(init?.signal ?? undefined);
        if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 });
        if (path.endsWith("/abort")) { aborts += 1; return jsonResponse(true); }
        if (path === "/session/status") return jsonResponse({ [sessionID]: { type: "busy" } });
        if (path === `/session/${sessionID}`) return jsonResponse({ id: sessionID, title: "Completion probe", time: { created: 1, updated: 10 } });
        if (path.endsWith("/message")) {
          historyCalls += 1;
          return jsonResponse(ready ? [{ info: info(), parts: [{ id: "answer_text", type: "text", text: "Done" }] }] : []);
        }
        return new Response("not found", { status: 404 });
      },
    });
    t.after(() => adapter.dispose());
    const received: ProviderEvent[] = [];
    await adapter.subscribe(null, (event) => { received.push(event); });
    if (origin === "owned") parentID = (await adapter.sendMessage(sessionID, { requestId: "terminal_busy", content: "Answer" })).providerTurnId!;
    events.push({ payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
    ready = true;
    const started = performance.now();
    if (origin !== "recovered") events.push({ payload: { type: "message.updated", properties: { info: info() } } });
    await waitFor(() => received.some((event) => event.type === "agent.completed"), "terminal output must settle while the provider remains busy");
    assert.ok(performance.now() - started < 1_000, "completion must not wait for runner cleanup");
    assert.ok(historyCalls >= 2, "terminal state requires matching history reads");
    assert.ok(reader.reads >= 2, "database activity must refresh during the confirmation window");

    const boundary = received.length;
    events.push({ payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
    events.push({ payload: { type: "message.updated", properties: { info: { ...info(), time: { created: 10, completed: 20 } } } } });
    events.push({ payload: { type: "session.idle", properties: { sessionID } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.hasActiveTurn(sessionID), false);
    assert.equal(adapter.activeSessionIds().includes(sessionID), false);
    assert.equal((await adapter.getSession(sessionID)).state, "idle", "a stale busy poll must not revive the task");
    assert.equal(received.filter((event) => event.type === "agent.completed").length, 1);
    assert.equal(received.slice(boundary).some((event) => event.payload.state === "working"), false);
    assert.equal(aborts, 0, "completion presentation must not abort the provider");
  });
}

for (const continuation of ["tool", "summary", "new-user", "new-assistant", "owned-follow-up", "live-follow-up", "error", "disconnect"] as const) {
  test(`OpenCode external terminal confirmation preserves a ${continuation} arriving during history checks`, async (t) => {
    const events = new SseFixture();
    const sessionID = "external_race";
    const info = { id: "external_answer", sessionID, role: "assistant", parentID: "external_user", finish: "stop", time: { created: 10 } };
    let historyCalls = 0;
    let advance = false;
    const adapter = new OpenCodeAdapter({
      directory: "C:/fixture",
      hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", nativeStatusPollIntervalMs: 60_000,
      fetch: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === "/global/event") return events.response(init?.signal ?? undefined);
        if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 });
        if (path.endsWith("/message")) {
          historyCalls += 1;
          return jsonResponse([
            { info: { ...info, ...(advance && continuation === "summary" ? { summary: true } : {}) }, parts: advance && continuation === "tool" ? [{ type: "tool", tool: "bash", state: { status: "running" } }] : [{ type: "text", text: "Done" }] },
            ...(advance && (continuation === "new-user" || continuation === "new-assistant")
              ? [{ info: { id: "new_message", sessionID, role: continuation === "new-user" ? "user" : "assistant", parentID: "new_parent", time: { created: 30 } }, parts: [] }]
              : []),
          ]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    t.after(() => adapter.dispose());
    let completions = 0;
    await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });
    events.push({ payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
    events.push({ payload: { type: "message.updated", properties: { info } } });
    await waitFor(() => historyCalls === 1, "the first external terminal confirmation must run");
    advance = true;
    if (continuation === "owned-follow-up") await adapter.sendMessage(sessionID, { requestId: "next_owned", content: "Keep going" });
    if (continuation === "live-follow-up") events.push({ payload: { type: "message.updated", properties: { info: {
      id: "live_next", sessionID, role: "assistant", parentID: "next_user", time: { created: 30 },
    } } } });
    if (continuation === "error") events.push({ payload: { type: "session.error", properties: { sessionID, error: { name: "UnknownError", data: { message: "Provider failed" } } } } });
    if (continuation === "disconnect") events.fail();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completions, 0, "an older external answer must not finish ongoing work");
    assert.equal(adapter.hasActiveTurn(sessionID), continuation !== "error" && continuation !== "disconnect");
  });
}

test("OpenCode wrap-up busy after a no-tool stop cannot keep the turn live", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_wrapup_busy/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_wrapup_busy/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_wrapup",
          sessionID: "ses_wrapup_busy",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 10 },
        },
        parts: [{ id: "wrapup_text", type: "text", text: "The answer is already on screen." }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
    nativeStatusPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  const states: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
  });

  const sent = await adapter.sendMessage("ses_wrapup_busy", { requestId: "wrapup_busy", content: "Answer now" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_wrapup",
    sessionID: "ses_wrapup_busy",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10 },
  } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_wrapup_busy", status: { type: "busy" } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_wrapup",
    sessionID: "ses_wrapup_busy",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10, completed: 20 },
  } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_wrapup_busy", status: { type: "busy" } } } });

  await waitFor(() => completions === 1, "step-finish stop must settle without waiting for session.idle or time.completed");
  assert.ok(historyCalls >= 2);
  assert.equal(adapter.hasActiveTurn("ses_wrapup_busy"), false);

  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_wrapup_busy", status: { type: "busy" } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_wrapup",
    sessionID: "ses_wrapup_busy",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10, completed: 20 },
  } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_wrapup_busy" } } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(completions, 1, "runner wrap-up busy and idle must not emit a second completion");
  assert.equal(states.includes("working"), false, "wrap-up busy after the answer must not revive working");
  assert.equal(adapter.hasActiveTurn("ses_wrapup_busy"), false);
});

test("OpenCode treats a persisted length finish as a completed no-tool turn", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_length_finish/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_length_finish/message") {
      return jsonResponse([{
        info: {
          id: "assistant_length",
          sessionID: "ses_length_finish",
          role: "assistant",
          parentID: promptId,
          finish: "length",
          time: { created: 10, completed: 20 },
        },
        parts: [{ id: "length_text", type: "text", text: "The reply was cut at the output cap." }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_length_finish", { requestId: "length_finish", content: "Write a long answer" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_length",
    sessionID: "ses_length_finish",
    role: "assistant",
    parentID: promptId,
    finish: "length",
    time: { created: 10, completed: 20 },
  } } } });

  await waitFor(() => completions === 1, "finish=length with no tools must settle the turn");
  assert.equal(adapter.hasActiveTurn("ses_length_finish"), false);
});

test("OpenCode keeps no-idle completion armed through the terminal assistant's closing text and reasoning parts", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_terminal_part/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_terminal_part/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_terminal_part",
          sessionID: "ses_terminal_part",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 10, completed: 20 },
        },
        parts: [
          { id: "terminal_reasoning", type: "reasoning", text: "The checks finished." },
          { id: "terminal_text", type: "text", text: "The focused checks passed." },
        ],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  const deltas: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
    if (event.type === "message.delta" && typeof event.payload.text === "string") deltas.push(event.payload.text);
  });

  const sent = await adapter.sendMessage("ses_terminal_part", { requestId: "terminal_part", content: "Run the checks" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_terminal_part",
    sessionID: "ses_terminal_part",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10, completed: 20 },
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "terminal_reasoning",
    messageID: "assistant_terminal_part",
    sessionID: "ses_terminal_part",
    type: "reasoning",
    text: "The checks finished.",
  } } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "terminal_text",
    messageID: "assistant_terminal_part",
    sessionID: "ses_terminal_part",
    type: "text",
    text: "",
  } } } });
  events.push({ payload: { type: "message.part.delta", properties: {
    sessionID: "ses_terminal_part",
    messageID: "assistant_terminal_part",
    partID: "terminal_text",
    field: "text",
    delta: "The focused checks passed.",
  } } });

  await waitFor(() => completions === 1, "closing text and reasoning parts must not cancel persisted terminal completion");
  assert.deepEqual(
    deltas,
    ["The checks finished.", "The focused checks passed."],
    "closing text and reasoning still reach the transcript",
  );
  assert.ok(historyCalls >= 2, "completion requires two matching persisted-history confirmations");
  assert.equal(completions, 1, "the no-idle terminal emits exactly one completion");
  assert.equal(adapter.hasActiveTurn("ses_terminal_part"), false);
});

test("OpenCode keeps a turn active when a tool continuation persists between terminal confirmations", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  let toolPersisted = false;
  const terminal = () => ({
    info: {
      id: "assistant_tool_step",
      sessionID: "ses_delayed_tool",
      role: "assistant",
      parentID: promptId,
      finish: "stop",
      time: { created: 10, completed: 20 },
    },
    parts: toolPersisted
      ? [{ id: "tool_part", type: "tool", tool: "bash", state: { status: "pending", input: { command: "npm test" } } }]
      : [{ id: "provisional_text", type: "text", text: "Checking now." }],
  });
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_delayed_tool/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_delayed_tool/message") {
      historyCalls += 1;
      return jsonResponse([terminal()]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_delayed_tool", { requestId: "delayed_tool", content: "Run the tests" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: terminal().info } } });
  await waitFor(() => historyCalls === 1, "the first terminal confirmation must read persisted history");
  toolPersisted = true;
  await waitFor(() => historyCalls >= 2, "the quiet confirmation must observe the delayed tool continuation");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(completions, 0);
  assert.equal(adapter.hasActiveTurn("ses_delayed_tool"), true);
});

test("OpenCode does not complete an earlier assistant when a chronologically later same-parent assistant is already persisted", async (t) => {
  const events = new SseFixture();
  let promptId: string | undefined;
  let historyCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_later_assistant/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_later_assistant/message") {
      historyCalls += 1;
      // Deliberately reverse array order: terminality follows provider time,
      // not whichever record the endpoint happens to serialize last.
      return jsonResponse([{
        info: {
          id: "assistant_later",
          sessionID: "ses_later_assistant",
          role: "assistant",
          parentID: promptId,
          time: { created: 30 },
        },
        parts: [{ id: "later_text", type: "text", text: "Continuing the same prompt." }],
      }, {
        info: {
          id: "assistant_earlier",
          sessionID: "ses_later_assistant",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 10, completed: 20 },
        },
        parts: [{ id: "earlier_text", type: "text", text: "First response." }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "agent.completed") completions += 1;
  });

  const sent = await adapter.sendMessage("ses_later_assistant", { requestId: "later_assistant", content: "Continue" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_earlier",
    sessionID: "ses_later_assistant",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 10, completed: 20 },
  } } } });
  await waitFor(() => historyCalls >= 2, "the earlier terminal candidate must be rechecked");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(completions, 0);
  assert.equal(adapter.hasActiveTurn("ses_later_assistant"), true);
});

test("OpenCode stops a repeated zero-token empty-response loop and exposes one useful error", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_empty_loop/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_empty_loop/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_empty_loop/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const errors: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "agent.error" && typeof event.payload.message === "string") errors.push(event.payload.message);
    if (event.type === "agent.completed") completions += 1;
  });
  const sent = await adapter.sendMessage("ses_empty_loop", { requestId: "empty_loop", content: "Say test" });
  assert.ok(sent.providerTurnId);
  const emptyAssistant = (id: string, created: number) => ({
    info: {
      id,
      sessionID: "ses_empty_loop",
      role: "assistant",
      parentID: sent.providerTurnId,
      finish: "unknown",
      time: { created, completed: created + 1 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}_start`, type: "step-start" },
      { id: `${id}_finish`, type: "step-finish", reason: "unknown" },
    ],
  });

  const first = emptyAssistant("assistant_empty_1", 1);
  history.push(first);
  events.push({ payload: { type: "message.updated", properties: { info: first.info } } });
  await waitFor(() => started.includes("assistant_empty_1"), "the first empty generation must remain ordinary provider evidence");
  assert.equal(abortCalls, 0, "one empty provider result is not enough to stop a task");

  const second = emptyAssistant("assistant_empty_2", 3);
  history.push(second);
  events.push({ payload: { type: "message.updated", properties: { info: second.info } } });
  await waitFor(() => abortCalls === 1 && errors.length === 1, "the confirmed repeated empty loop must fail once");

  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_empty_loop",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  const third = emptyAssistant("assistant_empty_3", 5);
  history.push(third);
  events.push({ payload: { type: "message.updated", properties: { info: third.info } } });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(abortCalls, 1);
  assert.equal(completions, 0);
  assert.deepEqual(started, ["assistant_empty_1"]);
  assert.deepEqual(errors, ["OpenCode returned repeated empty responses, so Tethoq stopped the turn. Retry or choose another model."]);
  assert.equal(adapter.hasActiveTurn("ses_empty_loop"), false);
});

test("OpenCode does not stop unknown-finish generations that contain real output", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  let abortCalls = 0;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_unknown_output/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_unknown_output/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_unknown_output/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, () => undefined);
  const sent = await adapter.sendMessage("ses_unknown_output", { requestId: "unknown_output", content: "Continue" });
  assert.ok(sent.providerTurnId);
  const info = (id: string, created: number) => ({
    id,
    sessionID: "ses_unknown_output",
    role: "assistant",
    parentID: sent.providerTurnId,
    finish: "unknown",
    time: { created, completed: created + 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  history.push({ info: info("assistant_empty", 1), parts: [
    { id: "empty_start", type: "step-start" },
    { id: "empty_finish", type: "step-finish", reason: "unknown" },
  ] });
  events.push({ payload: { type: "message.updated", properties: { info: info("assistant_empty", 1) } } });
  history.push({ info: info("assistant_text", 3), parts: [{ id: "real_text", type: "text", text: "Recovered" }] });
  events.push({ payload: { type: "message.updated", properties: { info: info("assistant_text", 3) } } });
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "real_text",
    messageID: "assistant_text",
    sessionID: "ses_unknown_output",
    type: "text",
    text: "Recovered",
  } } } });
  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(abortCalls, 0);
  assert.equal(adapter.hasActiveTurn("ses_unknown_output"), true);
});

test("an early unlabelled idle cannot finish a slow Tethoq-owned prompt", async (t) => {
  const events = new SseFixture();
  const history: unknown[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_slow_first/prompt_async") {
      // This can arrive before prompt_async has even returned. The adapter must
      // already know which exact Tethoq prompt owns the session.
      events.push({ payload: { type: "session.status", properties: { sessionID: "ses_slow_first", status: { type: "idle" } } } });
      events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_slow_first" } } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/ses_slow_first/message") return jsonResponse(history);
    if (url.pathname === "/session/ses_slow_first") return jsonResponse({
      id: "ses_slow_first",
      directory: "C:\\workspace",
      title: "Slow first token",
      time: { created: 1, updated: 2 },
    });
    if (url.pathname === "/session/status") return jsonResponse({ ses_slow_first: { type: "idle" } });
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  const completions: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.completed") completions.push(event.type);
  });

  const sent = await adapter.sendMessage("ses_slow_first", { requestId: "slow", content: "Say hi" });
  assert.ok(sent.providerTurnId);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.deepEqual(states, [], "idle status is not allowed to pump the Bridge queue");
  assert.deepEqual(completions, [], "a slow first token cannot be mistaken for a completed turn");
  assert.equal(adapter.hasActiveTurn("ses_slow_first"), true);
  assert.equal((await adapter.getSession("ses_slow_first")).state, "working",
    "catalogue refresh cannot repaint an owned prompt as idle before its response exists");

  const terminal = {
    info: {
      id: "assistant_slow",
      sessionID: "ses_slow_first",
      role: "assistant",
      parentID: sent.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "slow_text", type: "text", text: "Hi" }],
  };
  history.push(terminal);
  events.push({ payload: { type: "message.updated", properties: { info: terminal.info } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_slow_first" } } });
  await waitFor(() => completions.length === 1, "the exact persisted terminal response must complete normally");
  assert.equal(adapter.hasActiveTurn("ses_slow_first"), false);
});

test("a transient stale history read cannot lose the prompt's sole idle", async (t) => {
  const events = new SseFixture();
  let historyCalls = 0;
  let promptId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_idle_retry/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_idle_retry/message") {
      historyCalls += 1;
      if (historyCalls === 1) return jsonResponse([]);
      return jsonResponse([{
        info: { id: "assistant_retry", sessionID: "ses_idle_retry", role: "assistant", parentID: promptId, finish: "stop", time: { created: 1, completed: 2 } },
        parts: [{ id: "retry_text", type: "text", text: "Done" }],
      }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  let completions = 0;
  await adapter.subscribe(null, (event) => { if (event.type === "agent.completed") completions += 1; });
  const sent = await adapter.sendMessage("ses_idle_retry", { requestId: "retry", content: "Finish once" });
  promptId = sent.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_retry", sessionID: "ses_idle_retry", role: "assistant", parentID: promptId,
    finish: "stop", time: { created: 1, completed: 2 },
  } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_idle_retry" } } });

  await waitFor(() => completions === 1, "the bounded history recheck must recover the sole idle");
  assert.ok(historyCalls >= 3, "one stale read must be followed by two matching terminal confirmations");
  assert.equal(adapter.hasActiveTurn("ses_idle_retry"), false);
});

test("delayed guard cleanup cannot fail or complete a newer prompt", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let firstPromptId: string | undefined;
  let followupPromptId: string | undefined;
  let followupTerminal = false;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_guard_followup/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_guard_followup/message") return jsonResponse([{
      info: {
        id: "assistant_terminal",
        sessionID: "ses_guard_followup",
        role: "assistant",
        parentID: firstPromptId,
        finish: "stop",
        time: { created: 1, completed: 2 },
      },
      parts: [{ id: "terminal_text", type: "text", text: "Done" }],
    }, {
      info: {
        id: "assistant_runaway",
        sessionID: "ses_guard_followup",
        role: "assistant",
        parentID: firstPromptId,
        time: { created: 3 },
      },
      parts: [{ id: "runaway_text", type: "text", text: "Repeated" }],
    }, ...(followupTerminal ? [{
      info: {
        id: "assistant_followup",
        sessionID: "ses_guard_followup",
        role: "assistant",
        parentID: followupPromptId,
        finish: "stop",
        time: { created: 4, completed: 5 },
      },
      parts: [{ id: "followup_text", type: "text", text: "Second done" }],
    }] : [])]);
    if (url.pathname === "/session/ses_guard_followup/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const states: string[] = [];
  const errors: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.error") {
      const error = event.payload.error;
      errors.push(typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.name === "string" ? error.name : "unknown");
    }
    if (event.type === "agent.completed") completions += 1;
  });

  const first = await adapter.sendMessage("ses_guard_followup", { requestId: "first", content: "First" });
  firstPromptId = first.providerTurnId;
  assert.ok(firstPromptId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_terminal", sessionID: "ses_guard_followup", role: "assistant", parentID: firstPromptId,
    finish: "stop", time: { created: 1, completed: 2 },
  } } } });
  await waitFor(() => started.includes("assistant_terminal"), "the terminal answer must be visible");
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_runaway", sessionID: "ses_guard_followup", role: "assistant", parentID: firstPromptId, time: { created: 3 },
  } } } });
  await waitFor(() => abortCalls === 1, "the runaway turn must enter its cleanup barrier");

  const followupPromise = adapter.sendMessage("ses_guard_followup", { requestId: "followup", content: "Second" });
  // Delayed cleanup arrives after the follow-up is requested, but before its
  // dispatch is allowed to cross the guard barrier.
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_followup" } } });
  events.push({ payload: { type: "session.error", properties: {
    sessionID: "ses_guard_followup",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  } } });
  const followup = await followupPromise;
  assert.ok(followup.providerTurnId);
  assert.equal(completions, 1);
  assert.deepEqual(errors, []);
  followupPromptId = followup.providerTurnId;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_followup", sessionID: "ses_guard_followup", role: "assistant", parentID: followup.providerTurnId, time: { created: 4 },
  } } } });
  events.push({ payload: { type: "session.status", properties: { sessionID: "ses_guard_followup", status: { type: "busy" } } } });
  await waitFor(() => started.includes("assistant_followup") && states.includes("working"), "the new parent must own a normal live lifecycle");

  assert.equal(abortCalls, 1);
  assert.equal(completions, 1);
  assert.deepEqual(errors, []);
  assert.equal(adapter.hasActiveTurn("ses_guard_followup"), true);

  // Once the successor publishes its own terminal message, its idle is genuine
  // and must still complete normally despite the retained abort tombstone.
  followupTerminal = true;
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_followup", sessionID: "ses_guard_followup", role: "assistant", parentID: followup.providerTurnId,
    finish: "stop", time: { created: 4, completed: 5 },
  } } } });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_guard_followup" } } });
  await waitFor(() => completions === 2, "the successor's own idle must complete it");
  assert.equal(adapter.hasActiveTurn("ses_guard_followup"), false);
});

test("OpenCode preserves a stop response with a tool call and its same-prompt continuation", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let historyCalls = 0;
  let promptId: string | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_tools/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_tools/message") {
      historyCalls += 1;
      return jsonResponse([{
        info: {
          id: "assistant_after_tool",
          sessionID: "ses_tools",
          role: "assistant",
          parentID: promptId,
          finish: "stop",
          time: { created: 3, completed: 4 },
        },
        parts: [{ id: "final_text", type: "text", text: "The build passed." }],
      }]);
    }
    if (url.pathname === "/session/ses_tools/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  const completed: string[] = [];
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "agent.completed") completed.push(event.type);
  });
  const sent = await adapter.sendMessage("ses_tools", { requestId: "bridge_tools", content: "Check the build" });
  promptId = sent.providerTurnId;
  assert.ok(promptId);

  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_tool",
    sessionID: "ses_tools",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  // The final message update can race ahead of its tool part. Learning about
  // the tool afterwards must revoke the terminal candidate before the next
  // assistant step starts.
  events.push({ payload: { type: "message.part.updated", properties: { part: {
    id: "tool_part",
    messageID: "assistant_tool",
    sessionID: "ses_tools",
    type: "tool",
    tool: "bash",
    state: { status: "completed", output: "ok" },
  } } } });
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_after_tool",
    sessionID: "ses_tools",
    role: "assistant",
    parentID: promptId,
    finish: "stop",
    time: { created: 3, completed: 4 },
  } } } });
  await waitFor(() => started.includes("assistant_after_tool"), "the tool continuation must remain visible");

  assert.deepEqual(started, ["assistant_tool", "assistant_after_tool"]);
  assert.equal(abortCalls, 0);
  assert.equal(historyCalls, 0, "known tool turns do not need suspicious-continuation confirmation before idle");
  assert.equal(adapter.hasActiveTurn("ses_tools"), true);

  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_tools" } } });
  await waitFor(() => completed.length === 1, "session.idle must complete the healthy tool turn");
  assert.equal(adapter.hasActiveTurn("ses_tools"), false);
  assert.equal(abortCalls, 0);
  assert.ok(historyCalls >= 2, "the unlabelled idle requires two matching reads of the final no-tool response");
});

test("a normal completed prompt never suppresses the next user prompt in the same session", async (t) => {
  const events = new SseFixture();
  let abortCalls = 0;
  let historyCalls = 0;
  const history: unknown[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") return events.response(init?.signal ?? undefined);
    if (url.pathname === "/session/ses_followup/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_followup/message") {
      historyCalls += 1;
      return jsonResponse(history);
    }
    if (url.pathname === "/session/ses_followup/abort") {
      abortCalls += 1;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const started: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "message.started") {
      const info = event.payload.info;
      if (typeof info === "object" && info !== null && !Array.isArray(info) && typeof info.id === "string") started.push(info.id);
    }
    if (event.type === "agent.completed") completions += 1;
  });

  const first = await adapter.sendMessage("ses_followup", { requestId: "bridge_first", content: "First" });
  assert.ok(first.providerTurnId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_first",
    sessionID: "ses_followup",
    role: "assistant",
    parentID: first.providerTurnId,
    finish: "stop",
    time: { created: 1, completed: 2 },
  } } } });
  history.push({
    info: { id: "assistant_first", sessionID: "ses_followup", role: "assistant", parentID: first.providerTurnId, finish: "stop", time: { created: 1, completed: 2 } },
    parts: [{ id: "first_text", type: "text", text: "First done" }],
  });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_followup" } } });
  await waitFor(() => completions === 1, "the first prompt must complete normally");

  const second = await adapter.sendMessage("ses_followup", { requestId: "bridge_second", content: "Second" });
  assert.ok(second.providerTurnId);
  assert.notEqual(second.providerTurnId, first.providerTurnId);
  events.push({ payload: { type: "message.updated", properties: { info: {
    id: "assistant_second",
    sessionID: "ses_followup",
    role: "assistant",
    parentID: second.providerTurnId,
    finish: "stop",
    time: { created: 3, completed: 4 },
  } } } });
  history.push({
    info: { id: "assistant_second", sessionID: "ses_followup", role: "assistant", parentID: second.providerTurnId, finish: "stop", time: { created: 3, completed: 4 } },
    parts: [{ id: "second_text", type: "text", text: "Second done" }],
  });
  events.push({ payload: { type: "session.idle", properties: { sessionID: "ses_followup" } } });
  await waitFor(() => completions === 2, "the follow-up prompt must complete normally");

  assert.deepEqual(started, ["assistant_first", "assistant_second"]);
  assert.equal(abortCalls, 0);
  assert.ok(historyCalls >= 4, "each native idle requires two matching reads against its exact persisted parent");
  assert.equal(adapter.hasActiveTurn("ses_followup"), false);
});

test("replacement adapters never reuse provider event ids", async (t) => {
  const firstFeed = new SseFixture();
  const secondFeed = new SseFixture();
  const createAdapter = (feed: SseFixture) => new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: async (input, init) => requestUrl(input).pathname === "/global/event"
      ? feed.response(init?.signal ?? undefined)
      : jsonResponse({}),
    activityReader: new SequenceActivityReader(new Set()),
  });
  const first = createAdapter(firstFeed);
  const replacement = createAdapter(secondFeed);
  t.after(async () => {
    await first.dispose();
    await replacement.dispose();
  });
  const firstIds: string[] = [];
  const replacementIds: string[] = [];
  await first.subscribe(null, (event) => { firstIds.push(event.eventId); });
  await replacement.subscribe(null, (event) => { replacementIds.push(event.eventId); });

  firstFeed.push({ payload: { type: "session.status", properties: { sessionID: "ses_same", status: { type: "busy" } } } });
  secondFeed.push({ payload: { type: "session.status", properties: { sessionID: "ses_same", status: { type: "busy" } } } });
  await waitFor(() => firstIds.length === 1 && replacementIds.length === 1, "both adapter generations must publish their first event");

  assert.notEqual(firstIds[0], replacementIds[0], "Bridge dedupe must not mistake the replacement generation's first event for the retired adapter's first event");
  assert.equal(new Set([...firstIds, ...replacementIds]).size, 2);
});

test("retired same-session idle cannot complete a newer primary prompt", async (t) => {
  const primary = new SseFixture();
  const secondary = new SseFixture();
  const history: unknown[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/event") {
      return url.port === "63791"
        ? primary.response(init?.signal ?? undefined)
        : secondary.response(init?.signal ?? undefined);
    }
    if (url.pathname === "/session/ses_replaced/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/ses_replaced/message") return jsonResponse(history);
    return jsonResponse({});
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:63791/",
    secondaryBaseUrl: "http://127.0.0.1:4096/",
    secondaryActiveSessionIds: ["ses_replaced"],
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
    activityPollIntervalMs: 60_000,
  });
  t.after(() => adapter.dispose());
  const states: string[] = [];
  let completions = 0;
  await adapter.subscribe(null, (event) => {
    if (event.type === "session.status_changed" && typeof event.payload.state === "string") states.push(event.payload.state);
    if (event.type === "agent.completed") completions += 1;
  });

  const prompt = await adapter.sendMessage("ses_replaced", { requestId: "replacement_prompt", content: "New primary turn" });
  assert.ok(prompt.providerTurnId);

  secondary.push({ payload: { type: "session.status", properties: { sessionID: "ses_replaced", status: { type: "idle" } } } });
  secondary.push({ payload: { type: "message.updated", properties: { sessionID: "ses_replaced", info: { id: "retired_assistant", role: "assistant" } } } });
  secondary.push({ payload: { type: "session.idle", properties: { sessionID: "ses_replaced" } } });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(completions, 0, "the retired server cannot complete the replacement server's prompt");
  assert.equal(states.includes("idle"), false, "the retired server cannot make the replacement prompt look idle");
  assert.equal(adapter.hasActiveTurn("ses_replaced"), true);
  assert.equal(adapter.isSecondaryBusy(), false, "the retired feed still drains its own same-session activity");

  const assistant = {
    info: {
      id: "replacement_assistant",
      sessionID: "ses_replaced",
      role: "assistant",
      parentID: prompt.providerTurnId,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ id: "replacement_text", type: "text", text: "New turn complete" }],
  };
  history.push(assistant);
  primary.push({ payload: { type: "message.updated", properties: assistant } });
  primary.push({ payload: { type: "session.idle", properties: { sessionID: "ses_replaced" } } });
  await waitFor(() => completions === 1, "the replacement server's own idle must complete its prompt normally");

  assert.equal(adapter.hasActiveTurn("ses_replaced"), false);
  assert.equal(completions, 1);
});

for (const failed of [false, true]) {
  test(`native compaction on a retained server remains recoverable and settles from history (${failed})`, async (t) => {
    const primary = new SseFixture();
    const secondary = new SseFixture();
    const sessionID = "retained-context-goal";
    let history: unknown[] = [];
    const received: ProviderEvent[] = [];
    const adapter = new OpenCodeAdapter({
      hostId: "host", baseUrl: "http://127.0.0.1:63791/", secondaryBaseUrl: "http://127.0.0.1:63792/",
      secondaryActiveSessionIds: [sessionID], activityReader: new SequenceActivityReader(new Set()),
      activityPollIntervalMs: 60_000, nativeStatusPollIntervalMs: 20,
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.pathname === "/global/event") return (url.port === "63791" ? primary : secondary).response(init?.signal ?? undefined);
        if (url.pathname.endsWith("/message")) return jsonResponse(history);
        return jsonResponse({});
      },
    });
    t.after(() => adapter.dispose());
    await adapter.subscribe(null, event => { received.push(event); });
    secondary.push({ payload: { type: "session.error", properties: { sessionID, error: { name: "ContextOverflowError", data: { message: "Payload Too Large" } } } } });
    await waitFor(() => received.some(event => event.payload.recovery === "native_compaction"), "retained server reports recovery");
    assert.equal(received.some(event => event.type === "agent.error"), false);
    assert.equal(adapter.hasActiveTurn(sessionID), true);
    // Lose the final message SSE, as can happen while the desktop reconnects.
    history = [{ info: { id: "final", role: "assistant", parentID: "native-user", time: { created: 30, completed: 40 },
      finish: failed ? "error" : "stop", ...(failed ? { summary: true, error: { name: "ContextOverflowError", data: { message: "Unable to compact" } } } : {}) },
      parts: failed ? [] : [{ type: "text", text: "Work finished" }] }];
    secondary.push({ payload: { type: "session.idle", properties: { sessionID } } });
    await waitFor(() => received.some(event => event.type === (failed ? "agent.error" : "agent.completed")), "history confirms the retained turn's actual outcome");
    assert.equal(received.filter(event => event.type === "agent.error").length, failed ? 1 : 0);
    assert.equal(received.filter(event => event.type === "agent.completed").length, failed ? 0 : 1);
    assert.equal(adapter.isSecondaryBusy(), false);
    assert.equal(adapter.hasActiveTurn(sessionID), false);
  });
}

test("a secondary feed streams the retired server's turn and reports busy until it drains", async (t) => {
  const primary = new SseFixture();
  const secondary = new SseFixture();
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/global/health") return jsonResponse({});
    if (url.pathname === "/global/event") {
      return url.port === "63791"
        ? primary.response(init?.signal ?? undefined)
        : secondary.response(init?.signal ?? undefined);
    }
    return jsonResponse({});
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:63791/",
    secondaryBaseUrl: "http://127.0.0.1:4096/",
    secondaryActiveSessionIds: ["ses_already_busy"],
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });
  const received: string[] = [];
  await adapter.subscribe(null, (event) => { received.push(event.type); });
  t.after(() => adapter.dispose());

  // A turn that was already in flight when the feed attached counts as busy.
  assert.equal(adapter.isSecondaryBusy(), true, "seeded in-flight sessions keep the feed busy");
  assert.deepEqual(adapter.activeSessionIds(), [], "the seeded session is not a primary prompt");

  // The secondary feed forwards a new turn and marks it busy.
  secondary.push({
    payload: {
      type: "message.updated",
      properties: { sessionID: "ses_busy", info: { id: "msg_1", role: "assistant" } },
    },
  });
  await waitFor(() => received.includes("message.started"), "the secondary feed must forward session events");
  assert.equal(adapter.isSecondaryBusy(), true, "a turn streaming through the secondary feed counts as busy");

  // Its own connection handshake must not leak into the provider connection state.
  secondary.push({ payload: { type: "server.connected", properties: {} } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.includes("provider.connected"), false, "the secondary feed never reports connection state");

  // Draining the turns clears the busy signal.
  secondary.push({ payload: { type: "session.idle", properties: { sessionID: "ses_busy" } } });
  secondary.push({ payload: { type: "session.idle", properties: { sessionID: "ses_already_busy" } } });
  await waitFor(() => received.includes("agent.completed"), "session.idle must forward through the secondary feed");
  await waitFor(() => adapter.isSecondaryBusy() === false, "idle turns must drain the secondary feed");

  // Detaching the feed clears everything, including the seeded session.
  adapter.setSecondaryBaseUrl(undefined);
  assert.equal(adapter.isSecondaryBusy(), false);
  await adapter.dispose();
});

test("OpenCode context occupancy survives a trailing turn that recorded no usage", async () => {
  let providerCalls = 0;
  const assistant = (tokens: unknown) => ({ info: { role: "assistant", providerID: "crofai", modelID: "deepseek-v4-pro", ...(tokens === null ? {} : { tokens }), cost: 0.1 } });
  const fetchLike: FetchLike = async (input) => {
    const path = requestUrl(input).pathname;
    if (path === "/provider") {
      providerCalls += 1;
      return jsonResponse({
        connected: ["crofai"],
        all: [{ id: "crofai", name: "Crof", models: { "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", limit: { context: 1_000_000 } } } }],
      });
    }
    return jsonResponse([
      { info: { role: "user" } },
      assistant({ input: 40_000, output: 1_000, cache: { read: 100_000, write: 0 } }),
      // The turn that ends the session was interrupted, so it states no tokens at
      // all. Reading only this entry called a 141k conversation zero tokens in
      // context and drew a full-width empty gauge at 0% over a real transcript.
      assistant(null),
    ]);
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const context = await adapter.getSessionContext("ses_1");

  assert.equal(context.usedTokens, 141_000);
  assert.equal(context.contextWindowTokens, 1_000_000);
  assert.equal(Math.round((context.usedPercent ?? 0) * 100) / 100, 14.1);
  const refreshed = await adapter.getSessionContext("ses_1");
  assert.equal(refreshed.usedTokens, 141_000);
  assert.equal(refreshed.contextWindowTokens, 1_000_000);
  assert.equal(providerCalls, 1, "usage refreshes must not block on an unchanged model catalogue");
  await adapter.dispose();
});

test("OpenCode compaction is not cut off by the ordinary request timeout", async (t) => {
  let summarizeCalls = 0;
  let summarized = false;
  const fetchLike: FetchLike = async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path === "/session/ses_compact/message") {
      return jsonResponse([{
        info: {
          role: "assistant",
          providerID: "crofai",
          modelID: "deepseek-v4-pro",
          tokens: { input: 100_000, output: 2_000, cache: { read: 0, write: 0 } },
        },
      }, ...(summarized ? openCodeCompactionHistory() : [])]);
    }
    if (path === "/session/ses_compact/summarize") {
      summarizeCalls += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        const abort = () => {
          clearTimeout(timer);
          reject(init?.signal?.reason ?? new Error("aborted"));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      summarized = true;
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    requestTimeoutMs: 10,
    activityReader: new SequenceActivityReader(new Set()),
  });
  t.after(() => adapter.dispose());

  await adapter.compactSession("ses_compact");

  assert.equal(summarizeCalls, 1);
});

test("OpenCode compaction history cannot replace the ordinary model and reasoning selection", async (t) => {
  const events: ProviderEvent[] = [];
  const adapter = new OpenCodeAdapter({ hostId: "host", baseUrl: "http://localhost/",
    fetch: async (input, init) => requestUrl(input).pathname === "/global/event"
      ? new SseFixture().response(init?.signal ?? undefined)
      : jsonResponse([
          { info: { id: "ordinary", role: "assistant", providerID: "opencode-go", modelID: "muse", variant: "xhigh", time: { created: 1 } }, parts: [] },
          { info: { id: "marker", role: "user", model: { providerID: "other", modelID: "summary-model" }, time: { created: 2 } }, parts: [{ type: "compaction" }] },
          { info: { id: "summary", role: "assistant", parentID: "marker", summary: true, mode: "compaction", providerID: "other", modelID: "summary-model", time: { created: 3 } }, parts: [] },
        ]),
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await adapter.getMessages("session");
  const selection = events.find((event) => event.type === "session.updated");
  assert.equal(selection?.payload.modelId, "opencode-go/muse");
  assert.equal(selection?.payload.reasoningEffort, "xhigh");
});

test("OpenCode marks both snapshot and incremental compaction text before it reaches the renderer", async (t) => {
  const stream = new SseFixture();
  const deltas: ProviderEvent[] = [];
  const adapter = new OpenCodeAdapter({ hostId: "host", baseUrl: "http://localhost/",
    fetch: async (input, init) => requestUrl(input).pathname === "/global/event"
      ? stream.response(init?.signal ?? undefined) : jsonResponse([]),
  });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { if (event.type === "message.delta") deltas.push(event); });
  for (const [id, summary] of [["summary", true], ["ordinary", false]] as const) {
    stream.push({ payload: { type: "message.updated", properties: { info: { id, sessionID: "session", role: "assistant", summary } } } });
    stream.push({ payload: { type: "message.part.updated", properties: { part: { id: `${id}-part`, sessionID: "session", messageID: id, type: "text", text: "## Objective" } } } });
    stream.push({ payload: { type: "message.part.delta", properties: { sessionID: "session", messageID: id, partID: `${id}-part`, field: "text", delta: "\nNext steps" } } });
  }
  await waitFor(() => deltas.length === 4, "both live text routes");
  assert.deepEqual(deltas.map(event => event.payload.compaction), [true, true, undefined, undefined]);
});

function openCodeCompactionHistory(error?: unknown): unknown[] {
  return [
    { info: { id: "new-marker", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "new-summary", parentID: "new-marker", role: "assistant", summary: true, mode: "compaction", time: { completed: 20 }, ...(error !== undefined ? { error } : {}) } },
  ];
}

test("OpenCode compaction waits for new history after HTTP acknowledgment and shares concurrent requests", async (t) => {
  const baseline = [{ info: { role: "assistant", providerID: "test", modelID: "test" } },
    { info: { id: "old-marker", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "old-summary", parentID: "old-marker", role: "assistant", summary: true, time: { completed: 10 } } }];
  let history: unknown[] = baseline;
  let summarizeCalls = 0;
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host", baseUrl: "http://localhost/", compactionTimeoutMs: 5000,
    fetch: async (input) => {
      if (requestUrl(input).pathname.endsWith("/message")) return jsonResponse(history);
      summarizeCalls += 1;
      return jsonResponse({});
    },
  });
  t.after(() => adapter.dispose());
  let settled = false;
  const pending = adapter.compactSession("session").then(() => { settled = true; });
  const duplicate = adapter.compactSession("session");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(summarizeCalls, 1);
  assert.equal(settled, false, "neither HTTP success nor a stale summary proves completion");
  history = [...baseline, ...openCodeCompactionHistory()];
  await Promise.all([pending, duplicate]);
  assert.equal(settled, true);
});

test("OpenCode compaction restarts an acknowledged marker only when no summary began", async (t) => {
  let calls = 0;
  let history: unknown[] = [{ info: { role: "assistant", providerID: "test", modelID: "test" }, parts: [] }];
  const adapter = new OpenCodeAdapter({ directory: "C:/fixture", hostId: "host", baseUrl: "http://localhost/", compactionTimeoutMs: 6000,
    fetch: async (input) => {
      if (requestUrl(input).pathname.endsWith("/message")) return jsonResponse(history);
      calls++;
      const summary = openCodeCompactionHistory();
      history = [...history, ...(calls === 1 ? summary.slice(0, 1) : summary)];
      return jsonResponse(true);
    } });
  t.after(() => adapter.dispose());
  await adapter.compactSession("session");
  assert.equal(calls, 2);
});
