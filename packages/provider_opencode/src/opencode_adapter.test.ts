import assert from "node:assert/strict";
import test from "node:test";
import { type FetchLike } from "./http_client.js";
import type { OpenCodeActivityReader } from "./activity.js";
import { OpenCodeAdapter } from "./opencode_adapter.js";

class SequenceActivityReader implements OpenCodeActivityReader {
  readonly #snapshots: readonly ReadonlySet<string>[];
  #index = 0;
  public closed = false;
  public reads = 0;

  public constructor(...snapshots: readonly ReadonlySet<string>[]) {
    this.#snapshots = snapshots;
  }

  public async readWorkingSessionIds(): Promise<ReadonlySet<string>> {
    this.reads += 1;
    const snapshot = this.#snapshots[Math.min(this.#index, this.#snapshots.length - 1)] ?? new Set<string>();
    this.#index += 1;
    return snapshot;
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

test("OpenCode async prompts use a native message ID separate from bridge deduplication", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/session/ses_1/prompt_async");
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const result = await adapter.sendMessage("ses_1", {
    requestId: "bridge_request_1",
    content: "Run the focused tests",
    modelId: "openai/gpt-5",
    attachments: [{ name: "phone.jpg", mimeType: "image/jpeg", dataBase64: "AQID", byteLength: 3 }],
  });

  assert.ok(requestBody);
  const messageID = requestBody.messageID;
  assert.ok(typeof messageID === "string");
  assert.match(messageID, /^msg/);
  assert.notEqual(messageID, "bridge_request_1");
  assert.deepEqual(requestBody.parts, [
    { type: "text", text: "Run the focused tests" },
    { type: "file", mime: "image/jpeg", filename: "phone.jpg", url: "data:image/jpeg;base64,AQID" },
  ]);
  assert.deepEqual(requestBody.model, { providerID: "openai", modelID: "gpt-5" });
  assert.deepEqual(result, {
    accepted: true,
    providerTurnId: messageID,
    details: ["OpenCode accepted the asynchronous prompt."],
  });
});

test("OpenCode branches with the documented session fork endpoint", async () => {
  let requestBody: unknown;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/session/source/fork");
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse({
      id: "forked",
      directory: "C:\\workspace",
      title: "Forked history",
      time: { created: 1, updated: 2 },
    });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: new SequenceActivityReader(new Set()),
  });

  const session = await adapter.branchSession("source");

  assert.deepEqual(requestBody, {});
  assert.equal(session.providerSessionId, "forked");
  assert.equal(session.workingDirectory, "C:\\workspace");
  await adapter.dispose();
});

test("OpenCode session listing overrides the native 100-session default before local pagination", async () => {
  const nativeSessions = Array.from({ length: 125 }, (_, index) => ({
    id: `ses_${index}`,
    directory: "/workspace/project",
    title: `Session ${index}`,
    time: { created: index, updated: index },
  }));
  let nativeListUrl: URL | undefined;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") {
      nativeListUrl = url;
      const nativeLimit = Number(url.searchParams.get("limit") ?? "100");
      return jsonResponse(nativeSessions.slice(0, nativeLimit));
    }
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const page = await adapter.listSessions({ cursor: "100", limit: 50 });

  assert.ok(nativeListUrl);
  assert.equal(nativeListUrl.searchParams.get("limit"), String(Number.MAX_SAFE_INTEGER));
  assert.equal(page.sessions.length, 25);
  assert.equal(page.sessions[0]?.providerSessionId, "ses_100");
  assert.equal(page.sessions[24]?.providerSessionId, "ses_124");
  assert.equal(page.nextCursor, null);
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
  assert.equal(sessionReads, 1);
  assert.equal(statusReads, 1);
  assert.equal(reader.reads, 1);

  await adapter.listSessions({ limit: 40 });
  assert.equal(sessionReads, 2, "a later cursorless refresh starts a fresh native read cycle");
  assert.equal(statusReads, 2);
  assert.equal(reader.reads, 2);
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

test("OpenCode child-session listing filters the complete native session array before pagination", async () => {
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") return jsonResponse([
      { id: "root", title: "Root", time: { created: 1, updated: 1 } },
      { id: "child-a", parentID: "root", agent: "build", model: { providerID: "openai", id: "gpt-a", variant: "high" }, title: "A", time: { created: 2, updated: 2 } },
      { id: "child-b", parentID: "root", agent: "plan", model: { providerID: "openai", id: "gpt-b" }, title: "B", time: { created: 3, updated: 3 } },
      { id: "other", parentID: "different", title: "Other", time: { created: 4, updated: 4 } },
    ]);
    if (url.pathname === "/session/status") return jsonResponse({});
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: new SequenceActivityReader(new Set()) });

  const first = await adapter.listSessions({ parentProviderSessionId: "root", limit: 1 });
  assert.ok(first.nextCursor);
  const second = await adapter.listSessions({ parentProviderSessionId: "root", cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(first.sessions.map((session) => session.providerSessionId), ["child-a"]);
  assert.equal(first.sessions[0]?.parentSessionId, "host_1/opencode/root");
  assert.equal(first.sessions[0]?.modelId, "openai/gpt-a");
  assert.equal(first.sessions[0]?.variantId, "high");
  assert.deepEqual(second.sessions.map((session) => session.providerSessionId), ["child-b"]);
  assert.equal(second.nextCursor, null);
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
  await adapter.dispose();
});

test("OpenCode listing uses persisted work only when native status is unavailable", async () => {
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session") return jsonResponse([
      { id: "persisted", title: "Persisted", time: { created: 1, updated: 2 } },
      { id: "native-idle", title: "Native idle", time: { created: 1, updated: 2 } },
    ]);
    if (url.pathname === "/session/status") return jsonResponse({ "native-idle": { type: "idle" } });
    return new Response("not found", { status: 404 });
  };
  const reader = new SequenceActivityReader(new Set(["persisted", "native-idle"]));
  const adapter = new OpenCodeAdapter({ hostId: "host_1", baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike, activityReader: reader });

  const page = await adapter.listSessions();

  assert.equal(page.sessions.find((session) => session.providerSessionId === "persisted")?.state, "working");
  assert.equal(page.sessions.find((session) => session.providerSessionId === "native-idle")?.state, "idle");
  await adapter.dispose();
  assert.equal(reader.closed, true);
});

test("OpenCode persisted activity watcher emits working and idle transitions", async () => {
  const fetchLike: FetchLike = async () => new Response("data: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
      modelId: "openai/gpt-live",
      variantId: "high",
      parentSessionId: "host_1/opencode/root",
      agentRole: "build",
    },
    {
      providerSessionId: "child-live",
      modelId: "openai/gpt-live",
      variantId: "high",
      parentSessionId: "host_1/opencode/root",
      agentRole: "build",
      state: "working",
    },
  ]);
  await adapter.dispose();
});
