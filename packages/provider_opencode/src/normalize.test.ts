import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenCodeHttpClient, type FetchLike } from "./http_client.js";
import { normalizeOpenCodeMessages, normalizeOpenCodeSession, normalizeStatus } from "./normalize.js";

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
  assert.equal(messages[0]?.status, "completed");
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
