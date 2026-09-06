import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../../provider_contract/src/index.js";
import type { FetchLike } from "./http_client.js";
import { OpenCodeAdapter } from "./opencode_adapter.js";
import { normalizeOpenCodeMessages, normalizeOpenCodeToolEventPayload } from "./normalize.js";

const question = {
  id: "que_multi", sessionID: "ses_questions",
  questions: [
    { header: "Platform", question: "Which platform?", options: [{ label: "Desktop", description: "Desktop app" }], custom: false },
    { header: "Checks", question: "Which checks?", options: [{ label: "Tests", description: "Run tests" }, { label: "Build", description: "Compile" }], multiple: true },
  ],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function urlOf(input: Parameters<FetchLike>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

class EventFeed {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  response(signal?: AbortSignal): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        signal?.addEventListener("abort", () => {
          try { controller.close(); } catch {}
        }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }
  push(type: string, properties: unknown, directory = "C:/workspace"): void {
    this.controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for provider event");
}

test("OpenCode questions retain every field and submit answers in native question order", async (t) => {
  const feed = new EventFeed();
  const events: ProviderEvent[] = [];
  const replies: { url: URL; body: unknown }[] = [];
  let nativePending: unknown[] = [];
  let rejectFirstReply = true;
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") return feed.response(init?.signal ?? undefined);
    if (url.pathname === "/project") return json([]);
    if (url.pathname === "/question") return json(nativePending);
    if (url.pathname === "/session/status") return json({ ses_questions: { type: "busy" } });
    if (url.pathname === "/session/ses_questions") return json({ id: "ses_questions", directory: "C:/workspace" });
    if (url.pathname === "/question/que_multi/reply") {
      replies.push({ url, body: JSON.parse(String(init?.body)) });
      if (rejectFirstReply) {
        rejectFirstReply = false;
        return new Response("unavailable", { status: 503 });
      }
      nativePending = [];
      return json(true);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  assert.equal((await adapter.getCapabilities()).userInput, true);
  nativePending = [question];
  feed.push("question.asked", question);
  await waitFor(() => events.some((event) => event.type === "user_input.requested"));
  feed.push("question.asked", question);
  const requested = events.find((event) => event.type === "user_input.requested")!;
  assert.equal(requested.providerSessionId, "ses_questions");
  assert.equal(requested.payload.title, "Platform");
  assert.deepEqual(requested.payload.questions, question.questions.map((entry, index) => ({ ...entry, id: `question_${index}` })));
  assert.equal((await adapter.getSession("ses_questions")).state, "needs_input");
  const providerRequestId = "opencode_question_que_multi";
  await assert.rejects(adapter.respondToUserInput({ providerRequestId, answers: { question_0: "Desktop" } }), /Answer Checks/);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId, answers: { question_0: "Mobile", question_1: ["Tests"] } }), /offered by OpenCode/);
  await assert.rejects(adapter.respondToUserInput({ providerRequestId, answers: { question_0: ["Desktop", "Desktop"], question_1: ["Tests"] } }), /Answer Platform/);
  assert.equal(replies.length, 0);
  const answers = { question_1: { answers: ["Build", "A custom check"] }, question_0: "Desktop" };
  await assert.rejects(adapter.respondToUserInput({ providerRequestId, answers }), /503/);
  assert.equal(events.some((event) => event.type === "user_input.resolved"), false, "failed replies stay answerable");
  await adapter.respondToUserInput({ providerRequestId, answers });
  assert.deepEqual(replies.at(-1)?.body, { answers: [["Desktop"], ["Build", "A custom check"]] });
  assert.equal(replies.at(-1)?.url.searchParams.get("directory"), "C:/workspace");
  assert.deepEqual(events.find((event) => event.type === "user_input.resolved")?.payload, { providerRequestId, reason: "answered" });
  assert.equal(events.filter((event) => event.type === "user_input.requested").length, 1, "native repeats do not duplicate the card");
  await assert.rejects(adapter.respondToUserInput({ providerRequestId, answers }), /stale/);
});

test("OpenCode restores pending questions from the native project and resolves external rejection without completing the turn", async (t) => {
  const feed = new EventFeed();
  const events: ProviderEvent[] = [];
  let nativePending: unknown[] = [question];
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") return feed.response(init?.signal ?? undefined);
    if (url.pathname === "/project") return json([{ worktree: "C:/workspace" }]);
    if (url.pathname === "/question") return json(url.searchParams.get("directory") === "C:/workspace" ? nativePending : []);
    if (url.pathname === "/session/status") return json({ ses_questions: { type: "busy" } });
    if (url.pathname === "/session/ses_questions") return json({ id: "ses_questions", directory: "C:/workspace" });
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await waitFor(() => events.some((event) => event.type === "user_input.requested"));
  assert.equal((await adapter.getSession("ses_questions")).state, "needs_input");
  nativePending = [];
  feed.push("question.rejected", { sessionID: question.sessionID, requestID: question.id });
  await waitFor(() => events.some((event) => event.type === "user_input.resolved"));
  assert.deepEqual(events.find((event) => event.type === "user_input.resolved")?.payload, { providerRequestId: "opencode_question_que_multi", reason: "cancelled" });
  assert.equal((await adapter.getSession("ses_questions")).state, "working");
  assert.equal(events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted"), false);
});

test("OpenCode never reopens a question from a recovery response older than a native reply", async (t) => {
  const feed = new EventFeed();
  const events: ProviderEvent[] = [];
  let release: ((response: Response) => void) | undefined;
  let readFinished = false;
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") return feed.response(init?.signal ?? undefined);
    if (url.pathname === "/project") return json([]);
    if (url.pathname === "/question") {
      const response = await new Promise<Response>((resolve) => { release = resolve; });
      readFinished = true;
      return response;
    }
    return json({});
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await waitFor(() => release !== undefined);
  feed.push("question.replied", { sessionID: question.sessionID, requestID: question.id, answers: [["Desktop"], ["Tests"]] });
  await waitFor(() => events.some((event) => event.type === "user_input.resolved"));
  release!(json([question]));
  await waitFor(() => readFinished);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "user_input.requested"), false);
});

test("OpenCode reconnect retires a pending question that the provider no longer lists", async (t) => {
  const feed = new EventFeed();
  const events: ProviderEvent[] = [];
  let nativePending: unknown[] = [question];
  let subscriptions = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") { subscriptions += 1; return feed.response(init?.signal ?? undefined); }
    if (url.pathname === "/project") return json([]);
    if (url.pathname === "/question") return json(nativePending);
    return json({});
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await waitFor(() => events.some((event) => event.type === "user_input.requested"));
  feed.controller!.error(new Error("lost connection"));
  nativePending = [];
  await waitFor(() => subscriptions === 2);
  feed.push("server.connected", {});
  await waitFor(() => events.some((event) => event.type === "user_input.resolved"));
  assert.equal(events.filter((event) => event.type === "user_input.requested").length, 1);
});

test("OpenCode answers questions on the server and directory that asked them", async (t) => {
  const primary = new EventFeed();
  const secondary = new EventFeed();
  const events: ProviderEvent[] = [];
  let repliedUrl: URL | undefined;
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") return (url.port === "4097" ? secondary : primary).response(init?.signal ?? undefined);
    if (url.pathname === "/question/que_multi/reply") { repliedUrl = url; return json(true); }
    if (url.pathname === "/question") return json(url.port === "4097" && url.searchParams.get("directory") === "D:/retired server project" ? [question] : []);
    if (url.pathname === "/project") return json([]);
    return json({});
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch, secondaryBaseUrl: "http://127.0.0.1:4097/" });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  secondary.push("question.asked", question, "D:/retired server project");
  await waitFor(() => events.some((event) => event.type === "user_input.requested"));
  await adapter.respondToUserInput({ providerRequestId: "opencode_question_que_multi", answers: { question_0: ["Desktop"], question_1: ["Tests"] } });
  assert.equal(repliedUrl?.port, "4097");
  assert.equal(repliedUrl?.searchParams.get("directory"), "D:/retired server project");
});

test("OpenCode confirmed interruption cancels its pending questions", async (t) => {
  const feed = new EventFeed();
  const events: ProviderEvent[] = [];
  let nativePending: unknown[] = [question];
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === "/global/event") return feed.response(init?.signal ?? undefined);
    if (url.pathname === "/project") return json([]);
    if (url.pathname === "/question") return json(nativePending);
    if (url.pathname === "/session/ses_questions/abort") { nativePending = []; return json(true); }
    if (url.pathname === "/session/ses_questions") return json({ id: "ses_questions" });
    return json({});
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  await adapter.subscribe(null, (event) => { events.push(event); });
  await waitFor(() => events.some((event) => event.type === "user_input.requested"));
  await adapter.interrupt("ses_questions");
  assert.deepEqual(events.find((event) => event.type === "user_input.resolved")?.payload, { providerRequestId: "opencode_question_que_multi", reason: "cancelled" });
  assert.equal(events.some((event) => event.type === "agent.interrupted"), true);
  assert.equal((await adapter.getSession("ses_questions")).state, "idle");
  await assert.rejects(adapter.respondToUserInput({ providerRequestId: "opencode_question_que_multi", answers: { question_0: "Desktop", question_1: "Tests" } }), /stale/);
});

test("OpenCode session permission controls read real rules and append only a session override", async (t) => {
  const requests: { method: string; url: URL; body: unknown }[] = [];
  const customRule = { permission: "bash", pattern: "git *", action: "allow" };
  let permission: unknown[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method: init?.method ?? "GET", url, body });
    if (init?.method === "PATCH") permission = [...permission, ...(body as { permission: unknown[] }).permission];
    return json({ id: "ses_permission", directory: "C:/permission project", permission });
  };
  const adapter = new OpenCodeAdapter({ hostId: "host_1", fetch });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.getSessionPermissions("ses_permission")).controls[0]?.value, "default");
  permission = [customRule];
  assert.equal((await adapter.getSessionPermissions("ses_permission")).controls[0]?.value, "custom");
  const beforeInvalid = requests.length;
  await assert.rejects(adapter.setSessionPermission("ses_permission", "global", "allow"), /Choose Ask/);
  await assert.rejects(adapter.setSessionPermission("ses_permission", "tool_permissions", "default"), /Choose Ask/);
  assert.equal(requests.length, beforeInvalid);
  const updated = await adapter.setSessionPermission("ses_permission", "tool_permissions", "ask");
  assert.equal(updated.controls[0]?.value, "ask");
  assert.deepEqual(permission, [customRule, { permission: "*", pattern: "*", action: "ask" }]);
  const write = requests.find((entry) => entry.method === "PATCH")!;
  assert.equal(write.url.pathname, "/session/ses_permission");
  assert.equal(write.url.searchParams.get("directory"), "C:/permission project");
  assert.deepEqual(write.body, { permission: [{ permission: "*", pattern: "*", action: "ask" }] });
  assert.equal(requests.some((entry) => entry.url.pathname.includes("config")), false);
});

test("OpenCode question activity shows readable prompts in live events and loaded history", () => {
  const part = {
    type: "tool", tool: "question", id: "part_question", messageID: "msg_question", sessionID: question.sessionID,
    state: { status: "running", input: { questions: question.questions } },
  };
  const live = normalizeOpenCodeToolEventPayload(part);
  const history = normalizeOpenCodeMessages("host_1", question.sessionID, [{ info: { id: "msg_question", role: "assistant" }, parts: [part] }]);
  const tool = history[0]?.parts[0];
  assert.equal(live.name, "Question");
  assert.match(String(live.output), /Which platform\?\n- Desktop: Desktop app/);
  assert.match(String(live.output), /Which checks\?/);
  assert.match(String(live.output), /Waiting for your answer/);
  assert.doesNotMatch(String(live.output), /"questions"|"options"/);
  assert.equal(tool?.type, "tool");
  if (tool?.type === "tool") assert.equal(tool.output, live.output);
});
