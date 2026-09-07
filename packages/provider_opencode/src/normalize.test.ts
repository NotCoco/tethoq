import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenCodeHttpClient, type FetchLike } from "./http_client.js";
import { normalizeOpenCodeError, normalizeOpenCodeMessages, normalizeOpenCodeProviderStatus, normalizeOpenCodeSession, normalizeOpenCodeToolEventPayload, normalizeStatus } from "./normalize.js";

test("OpenCode image-limit failures expose actionable text in live and persisted history", () => {
  const failure = { name: "APIError", data: { statusCode: 400, isRetryable: false,
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] request contains 51 images, exceeding the maximum of 50 allowed per request",
    responseBody: "private transport body", responseHeaders: { authorization: "private header" }, metadata: { url: "https://private.example" } } };
  const error = normalizeOpenCodeError(failure);
  assert.equal(error.code, "IMAGE_LIMIT_EXCEEDED");
  assert.equal(error.recovery, "compact_context");
  assert.match(error.message, /51 images.*50 per request/);
  const [message] = normalizeOpenCodeMessages("host", "session", [{ info: { id: "failed", role: "assistant", error: failure }, parts: [] }]);
  assert.equal(message?.status, "failed");
  assert.deepEqual(message?.parts, [{ type: "error", code: error.code, message: error.message }]);
  assert.doesNotMatch(JSON.stringify(message?.parts), /private|responseBody|metadata|authorization/);
  for (const data of [
    { ...failure.data, statusCode: 429 },
    { ...failure.data, message: "API key rejected" },
    { ...failure.data, message: "request contains 4 images, exceeding the maximum of 50 allowed per request" },
  ]) assert.equal(normalizeOpenCodeError({ name: "APIError", data }).recovery, undefined);
  assert.deepEqual(normalizeOpenCodeError({ name: "APIError", data: { message: "Authentication failed for sk-secret-token at https://provider.example/?key=secret" } }),
    { code: "APIError", message: "Authentication failed for [redacted] at [provider URL]" });
});

const pdfFallbackPreamble = "Tethoq extracted this text because the selected OpenCode model does not advertise native PDF input.";

function persistedPdfFallbackParts(originalName: string, suffix = "one") {
  const surrogateName = `${originalName}.txt`;
  const extractedText = [
    pdfFallbackPreamble,
    `Original PDF: ${originalName}`,
    "Pages: 1",
    "",
    `Extracted sentence ${suffix}.`,
  ].join("\n");
  return [{
    id: `read_${suffix}`,
    type: "text",
    synthetic: true,
    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: surrogateName })}`,
  }, {
    id: `extracted_${suffix}`,
    type: "text",
    synthetic: true,
    text: extractedText,
  }, {
    id: `file_${suffix}`,
    type: "file",
    filename: surrogateName,
    mime: "text/plain",
    url: `data:text/plain;base64,${Buffer.from(extractedText, "utf8").toString("base64")}`,
  }];
}

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

test("OpenCode PDF fallback history presents one authored user row with the original PDF card", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_pdf", [{
    info: { id: "message_pdf", role: "user", time: { created: 1, completed: 2 } },
    parts: [
      { id: "authored", type: "text", text: "Quote the attached sentence." },
      ...persistedPdfFallbackParts("one-sentence-canary.pdf"),
    ],
  }]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts, [{
    type: "text",
    text: "Quote the attached sentence.",
    providerPartId: "authored",
  }, {
    type: "file",
    name: "one-sentence-canary.pdf",
    mimeType: "application/pdf",
  }]);
  assert.doesNotMatch(JSON.stringify(messages), /\.pdf\.txt|Called the Read tool|Tethoq extracted this text/u);
});

test("OpenCode attachment-only PDF fallback history keeps the original PDF without synthetic prose", () => {
  const messages = normalizeOpenCodeMessages("host_1", "session_pdf_only", [{
    info: { id: "message_pdf_only", role: "user", time: { created: 1, completed: 2 } },
    parts: persistedPdfFallbackParts("attachment-only.pdf"),
  }]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.parts, [{ type: "file", name: "attachment-only.pdf", mimeType: "application/pdf" }]);
});

test("OpenCode PDF fallback normalization is bundle-scoped across mixed attachments", () => {
  const userAuthoredRead = "Called the Read tool with the following input: {\"filePath\":\"first.pdf.txt\"}";
  const messages = normalizeOpenCodeMessages("host_1", "session_pdf_mixed", [{
    info: { id: "message_pdf_mixed", role: "user", time: { created: 1, completed: 2 } },
    parts: [
      ...persistedPdfFallbackParts("first.pdf", "first"),
      { id: "authored_read", type: "text", text: userAuthoredRead },
      { id: "ordinary_text_file", type: "file", filename: "notes.pdf.txt", mime: "text/plain", url: "data:text/plain;base64,SGk=" },
      ...persistedPdfFallbackParts("extensionless-document", "second"),
    ],
  }]);

  assert.deepEqual(messages[0]?.parts, [{ type: "file", name: "first.pdf", mimeType: "application/pdf" }, {
    type: "text",
    text: userAuthoredRead,
    providerPartId: "authored_read",
  }, {
    type: "file",
    name: "notes.pdf.txt",
    mimeType: "text/plain",
  }, {
    type: "file",
    name: "extensionless-document",
    mimeType: "application/pdf",
  }]);
});

test("OpenCode leaves unrelated synthetic Read echoes and genuine Read tools visible", () => {
  const orphanFallbackText = [pdfFallbackPreamble, "Original PDF: orphan.pdf", "Pages: 1", "", "Orphan content."].join("\n");
  const messages = normalizeOpenCodeMessages("host_1", "session_real_read", [{
    info: { id: "message_user", role: "user", time: { created: 1, completed: 2 } },
    parts: [{
      id: "synthetic_read",
      type: "text",
      synthetic: true,
      text: "Called the Read tool with the following input: {\"filePath\":\"notes.txt\"}",
    }, {
      id: "orphan_fallback",
      type: "text",
      synthetic: true,
      text: orphanFallbackText,
    }, {
      id: "notes_file",
      type: "file",
      filename: "notes.txt",
      mime: "text/plain",
      url: "data:text/plain;base64,SGk=",
    }],
  }, {
    info: { id: "message_assistant", role: "assistant", time: { created: 3, completed: 4 } },
    parts: [{
      id: "genuine_read_tool",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "C:\\work\\source.md" }, output: "Source contents" },
    }],
  }]);

  assert.deepEqual(messages[0]?.parts.map((part) => part.type), ["text", "text", "file"]);
  assert.match(messages[0]?.parts[0]?.type === "text" ? messages[0].parts[0].text : "", /Called the Read tool/u);
  assert.match(messages[0]?.parts[1]?.type === "text" ? messages[0].parts[1].text : "", /Tethoq extracted this text/u);
  assert.equal(messages[1]?.parts[0]?.type, "tool");
  assert.equal(messages[1]?.parts[0]?.type === "tool" ? messages[1].parts[0].providerPartId : undefined, "genuine_read_tool");
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

test("OpenCode history separates a completed zero-token deliberation leak from its final answer", () => {
  const leaked = [
    "The user is asking me to summarize a completed adapter repair for the visible application.",
    "We need to keep the private planning separate from the answer while preserving the provider text exactly enough for inspection.",
    "Keep it short.I found the completion boundary and fixed the stale working state without changing tool continuations.",
  ].join("\n\n");
  const messages = normalizeOpenCodeMessages("host_1", "session_leaked_reasoning", [{
    info: {
      id: "message_leaked_reasoning",
      role: "assistant",
      finish: "stop",
      time: { created: 1, completed: 2 },
      tokens: { input: 300, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "leaked_text", type: "text", text: leaked }],
  }]);

  assert.deepEqual(messages[0]?.parts, [{
    type: "reasoning",
    text: [
      "The user is asking me to summarize a completed adapter repair for the visible application.",
      "We need to keep the private planning separate from the answer while preserving the provider text exactly enough for inspection.",
      "Keep it short.",
    ].join("\n\n"),
    redacted: false,
    providerPartId: "leaked_text:reasoning-presentation",
  }, {
    type: "text",
    text: "I found the completion boundary and fixed the stale working state without changing tool continuations.",
    providerPartId: "leaked_text",
  }]);
});

test("OpenCode history leaves ordinary completed assistant prose untouched", () => {
  const prose = "The user can now inspect each completed result in the normal task view. I will respond directly. This sentence is part of an ordinary explanation, not private notes, and it must remain one assistant answer even when the provider reports zero reasoning tokens.";
  const messages = normalizeOpenCodeMessages("host_1", "session_ordinary_answer", [{
    info: {
      id: "message_ordinary_answer",
      role: "assistant",
      finish: "stop",
      time: { created: 1, completed: 2 },
      tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "ordinary_text", type: "text", text: prose }],
  }]);

  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: prose, providerPartId: "ordinary_text" }]);
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
    providerPartId: "edit_part",
    input: { filePath: "C:\\work\\src\\app.ts", oldString: "const old = true;", newString: "const ready = true;" },
    output: "File: C:\\work\\src\\app.ts\n\nReplaced:\nconst old = true;\n\nWith:\nconst ready = true;",
    status: "completed",
  }, {
    type: "tool",
    name: "Write C:\\work\\notes.md",
    providerPartId: "write_part",
    input: { filePath: "C:\\work\\notes.md", content: "# Release notes\n\nReady." },
    output: "File: C:\\work\\notes.md\n\nWritten content:\n# Release notes\n\nReady.",
    status: "completed",
  }, {
    type: "tool",
    name: "Run npm test",
    providerPartId: "run_part",
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
    partId: "edit_live",
    messageID: "assistant_live",
    sessionID: "session_1",
    tool: "edit",
    name: "Edit C:\\work\\live.ts",
    input: { filePath: "C:\\work\\live.ts", oldString: "old", newString: "new" },
    output: "File: C:\\work\\live.ts\n\nReplaced:\nold\n\nWith:\nnew",
    status: "running",
  });
});

test("OpenCode failed tool parts retain useful errors while EYES hides provider diagnostics", () => {
  const generic = normalizeOpenCodeToolEventPayload({
    id: "generic-failure",
    type: "tool",
    tool: "build",
    state: { status: "error", input: { target: "desktop" }, error: { message: "Compiler executable was not found" } },
  });
  assert.match(String(generic.output), /Compiler executable was not found/u);
  assert.equal(generic.status, "failed");

  const eyes = normalizeOpenCodeToolEventPayload({
    id: "eyes-failure",
    type: "tool",
    tool: "uar_mesh_tethoq_turn_support",
    state: {
      status: "error",
      output: "429 quota exhausted for api_key=private C:\\private\\session https://provider.invalid/private",
    },
  });
  assert.match(String(eyes.output), /usage limit was reached or it is temporarily rate-limited/u);
  assert.doesNotMatch(String(eyes.output), /api_key|provider\.invalid|private\\session/u);
  assert.equal(eyes.status, "failed");
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

test("OpenCode history hides mesh control turns and their assistant responses without disturbing real conversation", () => {
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    parentID?: string,
    parts?: readonly unknown[],
  ) => ({
    info: {
      id,
      role,
      ...(parentID !== undefined ? { parentID } : {}),
      ...(role === "assistant" ? { finish: "stop" } : {}),
      time: { created: 1, ...(role === "assistant" ? { completed: 2 } : {}) },
    },
    parts: parts ?? [{ id: `${id}_part`, type: "text", text }],
  });
  const messages = normalizeOpenCodeMessages("host_1", "mesh_history", [
    message("user_before", "user", "Explain the current state."),
    message("assistant_before", "assistant", "The task is still running.", "user_before"),
    message(
      "mesh_started",
      "user",
      "<tethoq_response_guidance>private orchestration</tethoq_response_guidance>\n\n<tethoq_hidden_control_turn>mesh-started:child-1</tethoq_hidden_control_turn>",
    ),
    message("mesh_started_tool", "assistant", "", "mesh_started", [{
      id: "mesh_started_tool_part",
      type: "tool",
      tool: "mesh_status",
      state: { status: "completed", output: "started" },
    }]),
    message("mesh_started_answer", "assistant", "Delegated task started.", "mesh_started"),
    message("mesh_result", "user", "<tethoq_hidden_control_turn>mesh-result:child-1</tethoq_hidden_control_turn>"),
    message("mesh_result_answer", "assistant", "Delegated result received.", "mesh_result"),
    message("user_after", "user", "Summarize the result."),
    message("assistant_after", "assistant", "Here is the ordinary summary.", "user_after"),
  ]);

  assert.deepEqual(messages.map((entry) => entry.providerMessageId), [
    "user_before",
    "assistant_before",
    "user_after",
    "assistant_after",
  ]);
  assert.deepEqual(messages.map((entry) => entry.parts[0]?.type === "text" ? entry.parts[0].text : entry.parts[0]?.type), [
    "Explain the current state.",
    "The task is still running.",
    "Summarize the result.",
    "Here is the ordinary summary.",
  ]);
});

test("OpenCode Continue hides only its control input, including out-of-order history", () => {
  const messages = normalizeOpenCodeMessages("host_1", "continue", [{
    info: { id: "resumed", role: "assistant", parentID: "button", finish: "stop", time: { created: 2, completed: 3 } },
    parts: [{ id: "answer", type: "text", text: "Resumed answer" }],
  }, {
    info: { id: "button", role: "user", time: { created: 1 } },
    parts: [{ type: "text", text: "<tethoq_response_guidance>Resume the task</tethoq_response_guidance>\n\n<tethoq_hidden_control_turn>continue</tethoq_hidden_control_turn>" }],
  }, {
    info: { id: "typed", role: "user", time: { created: 4 } },
    parts: [{ type: "text", text: "continue" }],
  }, {
    info: { id: "next", role: "assistant", parentID: "typed", finish: "stop", time: { created: 5, completed: 6 } },
    parts: [{ type: "text", text: "Next answer" }],
  }]);
  assert.deepEqual(messages.map(message => message.providerMessageId), ["resumed", "typed", "next"]);
  assert.deepEqual(messages.map(message => message.parts[0]?.type === "text" ? message.parts[0].text : ""), ["Resumed answer", "continue", "Next answer"]);
});

test("OpenCode hides parent-linked control responses even when history arrives out of order", () => {
  const messages = normalizeOpenCodeMessages("host_1", "mesh_out_of_order", [{
    info: { id: "control_answer", role: "assistant", parentID: "control_user", finish: "stop", time: { created: 2, completed: 3 } },
    parts: [{ id: "control_answer_part", type: "text", text: "Internal result" }],
  }, {
    info: { id: "control_user", role: "user", time: { created: 1 } },
    parts: [{ id: "control_user_part", type: "text", text: "<tethoq_hidden_control_turn>mesh-result:child-2</tethoq_hidden_control_turn>" }],
  }, {
    info: { id: "ordinary_user", role: "user", time: { created: 4 } },
    parts: [{ id: "ordinary_user_part", type: "text", text: "Continue normally." }],
  }]);

  assert.deepEqual(messages.map((entry) => entry.providerMessageId), ["ordinary_user"]);
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
  assert.equal(session.reasoningEffort, "high");

  const defaultVariant = normalizeOpenCodeSession("host/one", {
    id: "default/session",
    model: { providerID: "openai", id: "gpt-5.6" },
    time: { created: 1_760_000_000_000, updated: 1_760_000_030_000 },
  });
  assert.equal(defaultVariant.variantId, "default");
  assert.equal(defaultVariant.reasoningEffort, "default");
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
