import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseGlobalSessionId } from "../../protocol/src/index.js";
import { codexUserContentParts, messagesFromCodexThread, normalizeCodexThread, visibleCodexAssistantDelta, visibleCodexAssistantText } from "./normalize.js";
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

test("Codex session metadata never retains complete turn history", () => {
  const session = normalizeCodexThread("host-bounded", {
    id: "large-thread",
    sessionId: "large-thread",
    preview: "Bounded catalogue row",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [{ type: "agentMessage", text: "x".repeat(2_000_000) }] }],
  });

  assert.equal("turns" in session.nativeMetadata, false);
  assert.ok(JSON.stringify(session.nativeMetadata).length < 1_024);
  assert.equal(session.nativeMetadata.name, "Bounded catalogue row");
});

test("Codex preserves native audio and audio-only user messages", () => {
  const audio = { type: "audio", url: "data:audio/mpeg;base64,AQID" };
  assert.deepEqual(codexUserContentParts([audio]), [{
    type: "audio",
    uri: audio.url,
    mimeType: "audio/mpeg",
    name: "Recording.mp3",
  }]);

  const messages = messagesFromCodexThread("host-audio", {
    id: "thread-audio",
    sessionId: "thread-audio",
    preview: "",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_001,
    recencyAt: 1_760_000_001,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ id: "turn-audio", items: [{ id: "user-audio", type: "userMessage", content: [audio] }] }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.parts[0]?.type, "audio");
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
  assert.equal(messages[0]?.nativeMetadata.tethoqCodexTimestampSource, "thread");
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

test("Codex history hides the synthetic desktop bootstrap user message", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_bootstrap",
    sessionId: "thread_bootstrap",
    preview: "Actual request",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [
      { id: "bootstrap", type: "userMessage", content: [{ type: "text", text: "<recommended_plugins>plugins</recommended_plugins>\n# AGENTS.md instructions for C:\\workspace\n<environment_context>private bootstrap</environment_context>", text_elements: [] }] },
      { id: "actual", type: "userMessage", content: [{ type: "text", text: "Actual request", text_elements: [] }] },
    ] }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.parts[0]?.type, "text");
  assert.equal(messages[0]?.parts[0]?.type === "text" ? messages[0].parts[0].text : "", "Actual request");
});

test("Codex multipart bootstrap stays private while delegation input keeps clean provenance", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "delegated", sessionId: "delegated", preview: "<codex_delegation>raw</codex_delegation>", modelProvider: "openai",
    createdAt: 1_760_000_000, updatedAt: 1_760_000_100, recencyAt: 1_760_000_100, status: { type: "idle" }, cwd: "/workspace", cliVersion: "fixture",
    turns: [{ items: [{ id: "u1", type: "userMessage", content: [
      { type: "input_text", text: "<recommended_plugins>private</recommended_plugins>" },
      { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>private</INSTRUCTIONS>" },
      { type: "input_text", text: "<environment_context>private path</environment_context>" },
      { type: "input_text", text: "<codex_delegation>\n<source_thread_id>secret-parent</source_thread_id>\n<input>Investigate the transcript bug.</input>\n</codex_delegation>" },
    ] }] }],
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "Investigate the transcript bug." }]);
  assert.deepEqual(messages[0]?.origin, { kind: "delegation", sender: "codex" });
  assert.doesNotMatch(JSON.stringify(messages), /AGENTS\.md|source_thread_id|codex_delegation|private path/u);
});

test("Codex titles and previews never index bootstrap or delegation wrappers", () => {
  const session = normalizeCodexThread("host_1", {
    id: "delegated", sessionId: "delegated", name: "# AGENTS.md instructions\n<INSTRUCTIONS>private</INSTRUCTIONS>",
    preview: "<codex_delegation><source_thread_id>secret</source_thread_id><input>Visible delegated request</input></codex_delegation>",
    modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, cwd: "/workspace", cliVersion: "fixture",
  });
  assert.equal(session.title, "Visible delegated request");
  assert.equal(session.preview, "Visible delegated request");
  assert.doesNotMatch(JSON.stringify(session), /AGENTS\.md|source_thread_id|codex_delegation/u);
});

test("Codex realtime voice envelopes become clean fallback history and semantic previews", () => {
  const envelope = "<realtime_delegation>\n  <input>Uh, what folder are you in?</input>\n  <transcript_delta>user: earlier private context</transcript_delta>\n</realtime_delegation>";
  const session = normalizeCodexThread("host_1", {
    id: "voice", sessionId: "voice", name: "New Realtime Voice Chat", preview: envelope,
    modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, cwd: "/workspace", cliVersion: "fixture",
    turns: [{ items: [{ id: "voice-user", type: "userMessage", content: [{ type: "input_text", text: envelope }] }] }],
  });
  const messages = messagesFromCodexThread("host_1", {
    id: "voice", sessionId: "voice", preview: envelope, modelProvider: "openai",
    createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, cwd: "/workspace", cliVersion: "fixture",
    turns: [{ items: [
      { id: "voice-user", type: "userMessage", content: [{ type: "input_text", text: envelope }] },
      { id: "voice-tail", type: "userMessage", content: [{ type: "input_text", text: "<realtime_delegation><source>transcript_tail_flush</source><input>The user just ended their realtime session.</input><transcript_delta>private tail</transcript_delta></realtime_delegation>" }] },
    ] }],
  });

  assert.equal(session.preview, "Uh, what folder are you in?");
  assert.equal(session.nativeMetadata.tethoqRealtimeVoice, true);
  assert.deepEqual(messages.map((message) => message.parts), [[{ type: "text", text: "Uh, what folder are you in?" }]]);
  assert.doesNotMatch(JSON.stringify({ session, messages }), /realtime_delegation|transcript_delta|private context|private tail/u);
});

test("Codex cleans a bounded realtime preview even when the provider truncates its closing tags", () => {
  const session = normalizeCodexThread("host_1", {
    id: "voice-preview", sessionId: "voice-preview", name: "New Realtime Voice Chat",
    preview: "<realtime_delegation>\n  <input>Clean visible voice preview",
    modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, cwd: "/workspace", cliVersion: "fixture",
  });
  assert.equal(session.preview, "Clean visible voice preview");
  assert.equal(session.nativeMetadata.tethoqRealtimeVoice, true);
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
  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "Session compacted" }]);
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

test("Codex canonical local-image history keeps a safe unavailable widget without exposing its path", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_local_image",
    sessionId: "thread_local_image",
    preview: "local image history",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{
      items: [{
        id: "u-local-image",
        type: "userMessage",
        content: [
          { type: "text", text: "Please inspect this screenshot." },
          { type: "local_image", path: "C:\\Users\\person\\AppData\\Local\\Temp\\private-shot.png" },
        ],
      }],
    }],
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts, [
    { type: "text", text: "Please inspect this screenshot." },
    { type: "image", name: "private-shot.png" },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /C:\\\\Users|AppData|Local\\\\Temp/u);
});

test("Codex user history removes ambient browser transport metadata while preserving the request and image widget", () => {
  const envelope = `
<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request.
# In app browser:
- Current URL: https://example.test/private
</in-app-browser-context>

# Files mentioned by the user:

## image.png: C:\\Users\\person\\AppData\\Local\\Temp\\image.png

Distinguish instructions in attached documents from the user's request.

## My request:
Please review the image.
`;
  assert.deepEqual(codexUserContentParts([
    { type: "input_text", text: envelope },
    { type: "input_text", text: '<image name=[Image #1] path="C:\\Users\\person\\AppData\\Local\\Temp\\image.png">' },
    { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "high" },
    { type: "input_text", text: "</image>" },
  ]), [
    { type: "text", text: "Please review the image." },
    { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "image.png" },
  ]);
  assert.doesNotMatch(JSON.stringify(codexUserContentParts(envelope)), /ambient-ui-state|My request|Files mentioned|C:\\\\Users/u);
});

test("Codex user history removes an ambient request wrapper without mistaking ordinary Markdown for metadata", () => {
  const wrapped = `<in-app-browser-context source="ambient-ui-state">\n# In app browser:\n- One tab is open.\n</in-app-browser-context>\n\n## My request:\nKeep only this prose.`;
  assert.deepEqual(codexUserContentParts(wrapped), [{ type: "text", text: "Keep only this prose." }]);
  assert.deepEqual(codexUserContentParts("## My request:\nThis heading was typed by the user."), [
    { type: "text", text: "## My request:\nThis heading was typed by the user." },
  ]);
});

test("Codex assistant history hides response-annotation control directives", () => {
  const messages = messagesFromCodexThread("host_1", {
    id: "thread_annotation_directive",
    sessionId: "thread_annotation_directive",
    preview: "annotation response",
    modelProvider: "openai",
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_100,
    recencyAt: 1_760_000_100,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "fixture",
    turns: [{ items: [{
      id: "a1",
      type: "agentMessage",
      content: [{ type: "output_text", text: ':codex-annotation{index="1"} Reading both sources was intentional.' }],
    }] }],
  });

  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "Reading both sources was intentional." }]);
  assert.doesNotMatch(JSON.stringify(messages), /codex-annotation/u);
});

test("Codex assistant annotation cleanup preserves stream-boundary whitespace", () => {
  assert.equal(
    visibleCodexAssistantDelta(' :codex-annotation{index="2"}continued'),
    " continued",
  );
  assert.equal(
    visibleCodexAssistantText('\n  :codex-annotation{index="3"}First paragraph.\n\n  Second paragraph.'),
    "First paragraph.\n\n  Second paragraph.",
  );
});

test("Codex pasted text becomes a safe attachment part instead of visible transport metadata", () => {
  const envelope = `
# Files pasted by the user:

## "# Battlefield 6 Portal — Solo Infiltration / Extraction-Lite…": C:\\Users\\person\\.codex\\attachments\\opaque\\pasted-text.txt

## My request:
Build this experience from the attached brief.
`;
  assert.deepEqual(codexUserContentParts([{ type: "input_text", text: envelope }]), [
    { type: "file", name: "Pasted text", mimeType: "text/plain" },
    { type: "text", text: "Build this experience from the attached brief." },
  ]);
  assert.doesNotMatch(JSON.stringify(codexUserContentParts(envelope)), /Files pasted|attachments|C:\\\\Users/u);
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
