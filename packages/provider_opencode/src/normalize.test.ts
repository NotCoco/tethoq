import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenCodeHttpClient, type FetchLike } from "./http_client.js";
import { normalizeOpenCodeMessages, normalizeOpenCodeProviderStatus, normalizeOpenCodeSession, normalizeOpenCodeToolEventPayload, normalizeStatus } from "./normalize.js";

test("OpenCode sessions and message parts normalize from documented OpenAPI shapes", () => {
  const session = normalizeOpenCodeSession("host_1", {
    id: "session_1",
    directory: "/workspace/project",
    title: "Repair CI",
    time: { created: 1_760_000_000_000, updated: 1_760_000_030_000 },
  }, { type: "busy" });
  assert.equal(session.state, "working");
  assert.equal(session.project, "project");

  const messages = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "message_1", role: "assistant", time: { created: 1_760_000_000_000, completed: 1_760_000_001_000 } },
    parts: [
      { id: "p0", type: "reasoning", text: "Checking the failing route" },
      { id: "p1", type: "text", text: "Done" },
      { id: "p2", type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "npm test" }, output: "ok" } },
      { id: "p3", type: "patch", files: ["README.md"], hash: "abc" },
    ],
  }]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts.map((part) => part.type), ["reasoning", "text", "tool", "file_change"]);
  assert.deepEqual(messages[0]?.parts.slice(0, 2), [
    { type: "reasoning", text: "Checking the failing route", redacted: false, providerPartId: "p0" },
    { type: "text", text: "Done", providerPartId: "p1" },
  ]);
  assert.equal(messages[0]?.status, "completed");
});

test("OpenCode history keeps audio files playable while generic files stay files", () => {
  const message = normalizeOpenCodeMessages("host_1", "session_audio", [{
    info: { id: "message_audio", role: "user", time: { created: 1, completed: 2 } },
    parts: [
      { type: "file", filename: "voice.mp3", mime: "audio/mpeg", url: "data:audio/mpeg;base64,AQID" },
      { type: "file", filename: "notes.txt", mime: "text/plain", url: "data:text/plain;base64,SGk=" },
    ],
  }])[0];
  assert.deepEqual(message?.parts, [
    { type: "audio", uri: "data:audio/mpeg;base64,AQID", mimeType: "audio/mpeg", name: "voice.mp3" },
    { type: "file", name: "notes.txt", mimeType: "text/plain" },
  ]);
});

test("OpenCode history preserves distinct native identities for repeated reasoning parts", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "message_reasoning", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [
      { id: "reasoning_first", type: "reasoning", text: "First thought" },
      { id: "reasoning_second", type: "reasoning", text: "Second thought" },
    ],
  }]);

  assert.deepEqual(messages[0]?.parts, [
    { type: "reasoning", text: "First thought", redacted: false, providerPartId: "reasoning_first" },
    { type: "reasoning", text: "Second thought", redacted: false, providerPartId: "reasoning_second" },
  ]);
});

test("OpenCode edit, write, and run tools keep their target and concrete result", () => {
  const parts = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "message_tools", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{
      id: "edit_part",
      type: "tool",
      tool: "edit",
      state: { status: "completed", input: { filePath: "C:\\work\\src\\app.ts", oldString: "const old = true;", newString: "const ready = true;" }, output: "Edit applied successfully." },
    }, {
      id: "write_part",
      type: "tool",
      tool: "write",
      state: { status: "completed", input: { filePath: "C:\\work\\notes.md", content: "# Release notes\n\nReady." }, output: "Wrote file successfully." },
    }, {
      id: "run_part",
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "npm test", workdir: "C:\\work" }, output: "12 tests passed" },
    }],
  }])[0]?.parts ?? [];

  assert.deepEqual(parts, [{
    type: "tool",
    name: "Edit C:\\work\\src\\app.ts",
    input: { filePath: "C:\\work\\src\\app.ts", oldString: "const old = true;", newString: "const ready = true;" },
    output: "File: C:\\work\\src\\app.ts\n\nReplaced:\nconst old = true;\n\nWith:\nconst ready = true;",
    status: "completed",
  }, {
    type: "tool",
    name: "Write C:\\work\\notes.md",
    input: { filePath: "C:\\work\\notes.md", content: "# Release notes\n\nReady." },
    output: "File: C:\\work\\notes.md\n\nWritten content:\n# Release notes\n\nReady.",
    status: "completed",
  }, {
    type: "tool",
    name: "Run npm test",
    input: { command: "npm test", workdir: "C:\\work" },
    output: "Command: npm test\n\nWorking directory: C:\\work\n\nResult:\n12 tests passed",
    status: "completed",
  }]);

  assert.deepEqual(normalizeOpenCodeToolEventPayload({
    id: "edit_live",
    messageID: "assistant_live",
    sessionID: "session_1",
    type: "tool",
    tool: "edit",
    state: { status: "running", input: { filePath: "C:\\work\\live.ts", oldString: "old", newString: "new" } },
  }), {
    type: "tool",
    id: "edit_live",
    messageID: "assistant_live",
    sessionID: "session_1",
    tool: "edit",
    name: "Edit C:\\work\\live.ts",
    input: { filePath: "C:\\work\\live.ts", oldString: "old", newString: "new" },
    output: "File: C:\\work\\live.ts\n\nReplaced:\nold\n\nWith:\nnew",
    status: "running",
  });
});

test("OpenCode history suppresses empty patches and preserves named file changes", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "message_patches", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [
      { id: "patch_empty", type: "patch", files: [], hash: "empty" },
      { id: "patch_blank", type: "patch", files: ["", "   "], hash: "blank" },
      { id: "patch_named", type: "patch", files: [" src/named.ts ", ""], hash: "named" },
    ],
  }]);

  assert.deepEqual(messages[0]?.parts, [{
    type: "file_change",
    path: "src/named.ts",
    patch: "named",
    change: "modified",
  }]);
});

test("OpenCode history stops one prompt at its first completed stop response", () => {
  const message = (id: string, role: "user" | "assistant", parentID: string | undefined, text: string, finish?: string) => ({
    info: {
      id,
      role,
      ...(parentID !== undefined ? { parentID } : {}),
      ...(finish !== undefined ? { finish } : {}),
      time: { created: 1_760_000_000_000, ...(role === "assistant" ? { completed: 1_760_000_001_000 } : {}) },
    },
    parts: [{ id: `${id}_part`, type: "text", text }],
  });
  const messages = normalizeOpenCodeMessages("host_1", "session_1", [
    message("user_1", "user", undefined, "do this task"),
    message("assistant_1", "assistant", "user_1", "What task?", "stop"),
    message("assistant_runaway", "assistant", "user_1", "What task, again?", "stop"),
    message("user_2", "user", undefined, "Here are the details"),
    message("assistant_2", "assistant", "user_2", "Understood", "stop"),
  ]);

  assert.deepEqual(messages.map((entry) => entry.providerMessageId), ["user_1", "assistant_1", "user_2", "assistant_2"]);
});

test("OpenCode history preserves a stop response whose tool call legitimately continues the prompt", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "user_1", role: "user", time: { created: 1 } },
    parts: [{ id: "user_part", type: "text", text: "Check the build" }],
  }, {
    info: { id: "assistant_tool", role: "assistant", parentID: "user_1", finish: "stop", time: { created: 2, completed: 3 } },
    parts: [{ id: "tool_part", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }],
  }, {
    info: { id: "assistant_final", role: "assistant", parentID: "user_1", finish: "stop", time: { created: 4, completed: 5 } },
    parts: [{ id: "final_part", type: "text", text: "The build passed." }],
  }]);

  assert.deepEqual(messages.map((entry) => entry.providerMessageId), ["user_1", "assistant_tool", "assistant_final"]);
});

test("OpenCode child sessions normalize parent, agent, model, and variant metadata", () => {
  const session = normalizeOpenCodeSession("host/one", {
    id: "child/session",
    parentID: "parent/session",
    agent: "  build  ",
    model: { providerID: "openai", id: "gpt-5.6", variant: "  high  " },
    directory: "/workspace/project",
    title: "Child task",
    time: { created: 1_760_000_000_000, updated: 1_760_000_030_000 },
  }, { type: "busy" });

  assert.equal(session.parentSessionId, "host%2Fone/opencode/parent%2Fsession");
  assert.equal(session.agentRole, "build");
  assert.equal(session.modelId, "openai/gpt-5.6");
  assert.equal(session.variantId, "high");
  assert.equal("reasoningEffort" in session, false);
});

test("OpenCode status normalization does not treat unavailable status as idle", () => {
  for (const [status, expected] of [
    [undefined, "unknown"],
    [{}, "unknown"],
    ["idle", "idle"],
    ["active", "working"],
    ["busy", "working"],
    ["retry", "working"],
    ["error", "failed"],
  ] as const) {
    assert.equal(normalizeStatus(status), expected);
  }
});

test("OpenCode retry status prefers its safe action message and normalizes its retry time", () => {
  const status = normalizeOpenCodeProviderStatus({
    type: "retry",
    attempt: 1,
    message: "Raw detail https://opencode.ai/workspace/private",
    action: {
      message: "  Go limit reached\nTry again after the reset.\u0000 request_id=req_secret trace-id: trace_secret executionId=exec_secret 019c1234-5678-4abc-8def-1234567890ab https://opencode.ai/workspace/private  ",
    },
    next: 1_760_000_030_000,
  });

  assert.deepEqual(status, {
    kind: "retry",
    message: "Go limit reached Try again after the reset.",
    retryAt: "2025-10-09T08:53:50.000Z",
  });
  assert.doesNotMatch(JSON.stringify(status), /req_secret|trace_secret|exec_secret|019c1234/u);
});

test("OpenCode retry status falls back safely and omits invalid retry times", () => {
  const longMessage = `  ${"x".repeat(600)}\nhttps://example.test/private  `;
  const status = normalizeOpenCodeProviderStatus({
    type: "retry",
    action: { message: "https://example.test/private" },
    message: longMessage,
    next: Number.POSITIVE_INFINITY,
  });

  assert.equal(status?.kind, "retry");
  assert.equal(status?.message, "x".repeat(512));
  assert.equal("retryAt" in (status ?? {}), false);
  assert.equal(normalizeOpenCodeProviderStatus({ type: "busy", message: "not a retry" }), undefined);
});

test("OpenCode history distinguishes image attachments from compact generic files", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_1", [{
    info: { id: "message_attachments", role: "user", time: { created: 1_760_000_000_000 } },
    parts: [
      { type: "file", mime: "image/jpeg", filename: "C:\\Users\\person\\phone.jpg", url: "data:image/jpeg;base64,AQID" },
      { type: "file", mime: "application/pdf", filename: "C:\\Users\\person\\private\\notes.pdf", url: "file:///C:/Users/person/private/notes.pdf" },
      { type: "file", mime: "image/png", filename: "C:\\Users\\person\\private\\local.png", url: "C:\\Users\\person\\private\\local.png" },
    ],
  }]);

  assert.deepEqual(messages[0]?.parts, [
    { type: "image", uri: "data:image/jpeg;base64,AQID", mimeType: "image/jpeg", name: "phone.jpg" },
    { type: "file", name: "notes.pdf", mimeType: "application/pdf" },
    { type: "image", mimeType: "image/png", name: "local.png" },
  ]);
  assert.equal(JSON.stringify(messages[0]?.parts).includes("C:\\Users"), false);
  assert.equal(JSON.stringify(messages[0]?.parts).includes("file:///"), false);
});

test("OpenCode SSE parser yields every documented global event fixture", async () => {
  const fixture = await readFile("packages/provider_opencode/fixtures/global-events.sse", "utf8");
  const fetchLike: FetchLike = async () => new Response(fixture, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike });
  const events: unknown[] = [];
  for await (const event of client.sse("/global/event")) events.push(event);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => {
    if (typeof event !== "object" || event === null || !("payload" in event)) return undefined;
    const payload = event.payload;
    return typeof payload === "object" && payload !== null && "type" in payload ? payload.type : undefined;
  }), ["server.connected", "message.part.updated", "permission.updated"]);
});

test("OpenCode HTTP errors do not expose upstream response content", async () => {
  const upstreamCredential = ["provider", "credential", "fixture"].join("-");
  const upstreamPrompt = "confidential upstream prompt fixture";
  const fetchLike: FetchLike = async () => new Response(JSON.stringify({
    error: { message: `${upstreamCredential}: ${upstreamPrompt}` },
  }), { status: 429 });
  const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096/", fetch: fetchLike });

  await assert.rejects(client.request("POST", "/session", { body: { prompt: "Trigger a safe error" } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "OpenCode returned 429");
    assert.equal((error as { readonly code?: unknown }).code, "HTTP_429");
    assert.equal((error as { readonly retryable?: unknown }).retryable, true);
    assert.doesNotMatch(error.message, new RegExp(upstreamCredential, "u"));
    assert.doesNotMatch(error.message, new RegExp(upstreamPrompt, "u"));
    return true;
  });
});
