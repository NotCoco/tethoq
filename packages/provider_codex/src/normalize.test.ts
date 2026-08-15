import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseGlobalSessionId } from "../../protocol/src/index.js";
import { messagesFromCodexThread, normalizeCodexThread } from "./normalize.js";
import type { CodexThread, ThreadListResponse } from "./wire.js";

test("Codex fixture normalizes a generated-schema thread without losing native identity", async () => {
  const fixture = JSON.parse(await readFile("packages/provider_codex/fixtures/thread-list.json", "utf8")) as ThreadListResponse;
  const thread = fixture.data[0];
  assert.ok(thread);
  const session = normalizeCodexThread("host/codex", thread);
  assert.equal(session.providerId, "codex");
  assert.equal(session.providerSessionId, thread.id);
  assert.equal(session.title, "Refresh subsystem");
  assert.equal(session.project, "tethoq");
  assert.equal(session.state, "idle");
  assert.deepEqual(parseGlobalSessionId(session.id), {
    hostId: "host/codex",
    providerId: "codex",
    providerSessionId: thread.id,
  });
});
test("Codex session status distinguishes unavailable, idle, working, and failed states", () => {
  const thread = {
    id: "thread_status",
    sessionId: "thread_status",
    preview: "status",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
  } satisfies CodexThread;

  for (const [status, expected] of [
    [undefined, "unknown"],
    [{}, "unknown"],
    ["notLoaded", "unknown"],
    ["idle", "idle"],
    ["active", "working"],
    ["busy", "working"],
    ["retry", "working"],
    ["systemError", "failed"],
  ] as const) {
    assert.equal(normalizeCodexThread("host_1", { ...thread, status } as CodexThread).state, expected);
  }
});

test("Codex child-session and direct runtime metadata normalize without inferred values", () => {
  const session = normalizeCodexThread("host/one", {
    id: "child/thread",
    sessionId: "child/thread",
    parentThreadId: "parent/thread",
    agentNickname: "  Curie  ",
    agentRole: "  explorer  ",
    model: "  gpt-5.6-sol  ",
    effort: "  high  ",
    preview: "Inspect the provider",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
  });

  assert.equal(session.parentSessionId, "host%2Fone/codex/parent%2Fthread");
  assert.equal(session.agentNickname, "Curie");
  assert.equal(session.agentRole, "explorer");
  assert.equal(session.modelId, "gpt-5.6-sol");
  assert.equal(session.reasoningEffort, "high");

  const withoutMetadata = normalizeCodexThread("host_1", {
    id: "standalone",
    sessionId: "standalone",
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    preview: "Standalone",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
  });
  assert.equal("parentSessionId" in withoutMetadata, false);
  assert.equal("modelId" in withoutMetadata, false);
  assert.equal("reasoningEffort" in withoutMetadata, false);
});

test("Codex history normalization preserves user, assistant, command, file, and tool content", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_1",
    sessionId: "thread_1",
    preview: "history",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{
      items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "Run the tests", text_elements: [] }] },
        { id: "a1", type: "agentMessage", text: "Running them now." },
        { id: "c1", type: "commandExecution", command: "npm test", cwd: "/workspace", aggregatedOutput: "ok", exitCode: 0, status: "completed" },
        { id: "f1", type: "fileChange", changes: [{ path: "README.md", kind: "modified", diff: "+done" }], status: "completed" },
        { id: "t1", type: "mcpToolCall", tool: "inspect", server: "fs", arguments: { path: "." }, status: "completed", result: { content: [{ text: "complete" }] } },
        { id: "w1", type: "webSearch", query: "codex docs", results: [{ title: "x" }] },
        { id: "d1", type: "dynamicToolCall", tool: "search", arguments: { q: "x" }, status: "failed", contentItems: null },
        {
          id: "s1",
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          status: "inProgress",
          senderThreadId: "thread_1",
          receiverThreadIds: ["child/one"],
          prompt: "Inspect the normalizer",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          agentsStates: { "child/one": { status: "running", message: "Reviewing provider shapes" } },
        },
        { id: "c2", type: "commandExecution", command: "rm -rf /bad", cwd: "/workspace", aggregatedOutput: "", exitCode: 1, status: "declined" },
      ],
    }],
  });
  assert.equal(messages.length, 9);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant", "tool", "tool", "tool", "tool", "tool"]);
  assert.equal(messages[0]?.parts[0]?.type, "text");
  assert.equal(messages[2]?.parts[0]?.type, "command");
  assert.equal(messages[3]?.parts[0]?.type, "file_change");
  assert.equal(messages[4]?.parts[0]?.type, "tool");
  const filePart = messages[3]?.parts[0];
  assert.ok(filePart && filePart.type === "file_change");
  assert.equal(filePart.path, "README.md");
  const mcpPart = messages[4]?.parts[0];
  assert.ok(mcpPart && mcpPart.type === "tool");
  assert.equal(mcpPart.name, "inspect");
  const webPart = messages[5]?.parts[0];
  assert.ok(webPart && webPart.type === "tool");
  assert.equal(webPart.name, "webSearch");
  const failedTool = messages[6]?.parts[0];
  assert.ok(failedTool && failedTool.type === "tool");
  assert.equal(failedTool.status, "failed");
  const subagent = messages[7]?.parts[0];
  assert.deepEqual(subagent, {
    type: "subagent",
    tool: "spawn_agent",
    action: "spawn",
    status: "running",
    receiverSessionIds: ["host_1/codex/child%2Fone"],
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    prompt: "Inspect the normalizer",
    summary: "Reviewing provider shapes",
  });
  const declinedCommand = messages[8]?.parts[0];
  assert.ok(declinedCommand && declinedCommand.type === "command");
  assert.equal(declinedCommand.status, "failed");
});

test("Codex history never flattens unknown structured traces into assistant prose", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_unknown_trace",
    sessionId: "thread_unknown_trace",
    preview: "trace guard",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [
      { id: "raw-1", type: "providerBrowserSnapshot", url: "https://example.test", text: "full raw DOM trace", nodes: [{ id: 1, text: "secret metadata" }] },
      { id: "compact-1", type: "contextCompaction", summary: { huge: "provider envelope" } },
    ] }],
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.providerMessageId, "compact-1");
  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "Context compacted" }]);
  assert.equal(JSON.stringify(messages).includes("full raw DOM trace"), false);
  assert.equal(JSON.stringify(messages).includes("secret metadata"), false);
});

test("Codex user history preserves images while removing only its synthetic attachment envelope", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_images",
    sessionId: "thread_images",
    preview: "image history",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{
      items: [{
        id: "u1",
        type: "userMessage",
        content: [
          {
            type: "input_text",
            text: "\n# Files mentioned by the user:\n\n## screenshot.png: C:/Users/person/AppData/Local/Temp/screenshot.png\n\n## My request:\nPlease match this layout.\n",
          },
          { type: "input_text", text: '<image name=[Image #1] path="C:\\Users\\person\\AppData\\Local\\Temp\\screenshot.png">' },
          { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "high" },
          { type: "input_text", text: "</image>" },
          { type: "image", imageUrl: "https://example.test/diagram.webp", filename: "C:\\Users\\person\\diagram.webp" },
        ],
      }],
    }],
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts, [
    { type: "text", text: "Please match this layout." },
    { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "screenshot.png" },
    { type: "image", uri: "https://example.test/diagram.webp", name: "diagram.webp" },
  ]);
  assert.equal(JSON.stringify(messages[0]?.parts).includes("C:\\Users"), false);
  assert.equal(messages[0]?.editable, undefined);
});

test("Codex attachment cleanup leaves ordinary user text untouched", () => {
  const text = "Documentation example:\n# Files mentioned by the user:\n## My request:\nstill ordinary text.";
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_plain_text",
    sessionId: "thread_plain_text",
    preview: text,
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text }] }] }],
  });

  assert.deepEqual(messages[0]?.parts, [{ type: "text", text }]);
  assert.equal(messages[0]?.editable, true);
});

test("Codex subagent normalization preserves unknown lifecycle values without exposing host paths", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_subagent_unknown",
    sessionId: "thread_subagent_unknown",
    preview: "subagent",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [{
      id: "s1",
      type: "collabAgentToolCall",
      tool: "provider_specific_action",
      status: "providerSpecificState",
      receiverThreadIds: ["child"],
      prompt: "Inspect C:\\private\\repo",
      agentsStates: { child: { status: "providerSpecificState", message: "Working in /private/repo" } },
    }] }],
  });

  assert.deepEqual(messages[0]?.parts, [{
    type: "subagent",
    tool: "provider_specific_action",
    action: "unknown",
    status: "unknown",
    receiverSessionIds: ["host_1/codex/child"],
  }]);
});
