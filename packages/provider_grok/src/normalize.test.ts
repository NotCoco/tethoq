import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acpUpdateLooksLikeThought,
  appendAcpContentChunk,
  appendAcpSubagentPart,
  completeAcpMessages,
  createMessageAccumulator,
  normalizeGrokSubagentUpdate,
  normalizeAcpSession,
} from "./normalize.js";

test("ACP session metadata normalizes into a Grok session", () => {
  const session = normalizeAcpSession("host_1", {
    sessionId: "grok-session-1",
    cwd: "/workspace/grok-project",
    title: "Inspect Grok",
    updatedAt: "2026-08-07T10:00:00.000Z",
    modelId: "grok-4.6",
    thought_level: "xhigh",
  });
  assert.equal(session.providerId, "grok");
  assert.equal(session.project, "grok-project");
  assert.equal(session.lastActivityAt, "2026-08-07T10:00:00.000Z");
  assert.equal(session.state, "unknown");
  assert.equal(session.modelId, "grok-4.6");
  assert.equal(session.reasoningEffort, "xhigh");
});

test("untitled Grok sessions stay distinct from a titled chat in the same project", () => {
  const populated = normalizeAcpSession("host_1", {
    sessionId: "populated",
    cwd: "/workspace/hand_model",
    title: "Most Recent Hand Model Blender Gun File",
  });
  const untitled = normalizeAcpSession("host_1", {
    sessionId: "untitled",
    cwd: "/workspace/hand_model",
  });

  assert.equal(populated.title, "Most Recent Hand Model Blender Gun File");
  assert.equal(untitled.title, "Untitled Grok session");
  assert.equal(populated.project, "hand_model");
  assert.equal(untitled.project, "hand_model");
  assert.notEqual(populated.id, untitled.id);
});

test("ACP session state is derived only from explicit native status metadata", () => {
  const session = {
    sessionId: "grok-session-1",
    updatedAt: "2026-08-07T10:00:00.000Z",
  };

  for (const [status, expected] of [
    [undefined, "unknown"],
    [{}, "unknown"],
    ["idle", "idle"],
    ["active", "working"],
    ["busy", "working"],
    ["retry", "working"],
    ["completed", "completed"],
    ["complete", "completed"],
    ["success", "completed"],
    [{ type: "succeeded" }, "completed"],
    ["error", "failed"],
  ] as const) {
    assert.equal(normalizeAcpSession("host_1", { ...session, status }).state, expected);
  }
});

test("ACP streamed content chunks coalesce by messageId and complete in order", async () => {
  const lines = (await readFile("packages/provider_grok/fixtures/session-updates.jsonl", "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as unknown);
  const accumulator = createMessageAccumulator();
  for (const line of lines) {
    if (typeof line !== "object" || line === null || !("params" in line)) continue;
    const params = line.params;
    if (typeof params !== "object" || params === null || !("update" in params)) continue;
    const update = params.update;
    if (typeof update !== "object" || update === null || !("sessionUpdate" in update)) continue;
    if (update.sessionUpdate === "agent_message_chunk") {
      appendAcpContentChunk("host_1", "grok-session-1", "assistant", update as Record<string, unknown>, accumulator, new Date("2026-08-07T10:00:00Z"));
    }
  }
  const messages = completeAcpMessages(accumulator, new Date("2026-08-07T10:00:01Z"));
  assert.equal(messages.length, 1);
  const part = messages[0]?.parts[0];
  assert.equal(part?.type, "text");
  assert.equal(part?.type === "text" ? part.text : undefined, "Hello from Grok");
  assert.equal(messages[0]?.status, "completed");
});

test("ACP thought flags and thinking content types look like live thought", () => {
  assert.equal(acpUpdateLooksLikeThought({
    content: { type: "thinking", thinking: "Tracing the failure" },
  }, "agent_message_chunk"), true);
  assert.equal(acpUpdateLooksLikeThought({
    thought: true,
    content: { type: "text", text: "Hidden trace" },
  }, "agent_message_chunk"), true);
  assert.equal(acpUpdateLooksLikeThought({
    content: { type: "text", text: "Hello from Grok" },
  }, "agent_message_chunk"), false);
});

test("ACP thought content blocks become reasoning text", () => {
  const accumulator = createMessageAccumulator();
  appendAcpContentChunk(
    "host_1",
    "grok-session-1",
    "assistant",
    { content: { type: "thought", thought: "Checking the failing test" } },
    accumulator,
    new Date("2026-08-07T10:00:00Z"),
    true,
    "assistant_prompt_prompt-1",
    "reasoning",
  );
  const part = completeAcpMessages(accumulator)[0]?.parts[0];
  assert.equal(part?.type === "reasoning" ? part.text : undefined, "Checking the failing test");
});

test("ACP thinking chunks preserve readable sentence boundaries", () => {
  const accumulator = createMessageAccumulator();
  for (const text of ["Verify 480p then poll.", "Poll until done.", "Wait for completion.", "Fast finish."]) {
    appendAcpContentChunk(
      "host_1",
      "grok-session-1",
      "assistant",
      { content: { type: "text", text } },
      accumulator,
      new Date("2026-08-07T10:00:00Z"),
      true,
      "assistant_prompt_prompt-1",
      "reasoning",
    );
  }
  const part = completeAcpMessages(accumulator)[0]?.parts[0];
  assert.equal(part?.type === "reasoning" ? part.text : undefined, "Verify 480p then poll. Poll until done. Wait for completion. Fast finish.");
});

test("ACP history keeps Grok thinking separate from final output", () => {
  const accumulator = createMessageAccumulator();
  const metadata = { promptId: "prompt-1" };
  appendAcpContentChunk(
    "host_1",
    "grok-session-1",
    "assistant",
    { content: { type: "text", text: "Inspecting the project" } },
    accumulator,
    new Date("2026-08-07T10:00:00Z"),
    true,
    "assistant_prompt_prompt-1",
    "reasoning",
  );
  appendAcpContentChunk(
    "host_1",
    "grok-session-1",
    "assistant",
    { content: { type: "text", text: "Final answer" }, _meta: metadata },
    accumulator,
    new Date("2026-08-07T10:00:01Z"),
    true,
    "assistant_prompt_prompt-1",
  );

  const message = completeAcpMessages(accumulator)[0];
  assert.deepEqual(message?.parts, [
    { type: "reasoning", text: "Inspecting the project", redacted: false },
    { type: "text", text: "Final answer" },
  ]);
});

test("ACP history preserves alternating reasoning and assistant text chronology", () => {
  const accumulator = createMessageAccumulator();
  const append = (text: string, partType: "text" | "reasoning") => appendAcpContentChunk(
    "host_1",
    "grok-session-1",
    "assistant",
    { content: { type: "text", text } },
    accumulator,
    new Date("2026-08-07T10:00:00Z"),
    true,
    "assistant_prompt_prompt-1",
    partType,
  );

  append("First thought", "reasoning");
  append("Visible update", "text");
  append("Second thought", "reasoning");

  const message = completeAcpMessages(accumulator)[0];
  assert.deepEqual(message?.parts, [
    { type: "reasoning", text: "First thought", redacted: false },
    { type: "text", text: "Visible update" },
    { type: "reasoning", text: "Second thought", redacted: false },
  ]);
});

test("ACP live chunks retain only the latest delta instead of recopying the full stream", () => {
  const accumulator = createMessageAccumulator();
  for (let index = 0; index < 10_000; index += 1) {
    appendAcpContentChunk(
      "host_1",
      "grok-session-1",
      "assistant",
      { messageId: "message-1", content: { type: "text", text: "x" } },
      accumulator,
      new Date("2026-08-07T10:00:00Z"),
      false,
    );
  }
  const message = accumulator.messages.get("message-1");
  assert.equal(message?.parts.length, 1);
  assert.equal(message?.parts[0]?.type === "text" ? message.parts[0].text : undefined, "x");
});

test("Grok subagent lifecycle uses explicit status and only supplied openable child ids", () => {
  const spawned = normalizeGrokSubagentUpdate({
    sessionUpdate: "subagent_spawned",
    subagent_id: "worker-1",
    child_session_id: "child-1",
    description: "Inspect the parser",
    model: "grok-build",
    reasoning_effort: "high",
  });
  assert.deepEqual(spawned, {
    type: "subagent",
    tool: "spawn_subagent",
    action: "spawn",
    status: "running",
    receiverSessionIds: [],
    modelId: "grok-build",
    reasoningEffort: "high",
    summary: "Inspect the parser",
  });

  const finished = normalizeGrokSubagentUpdate({
    sessionUpdate: "subagent_finished",
    subagent_id: "worker-1",
    child_session_id: "child-1",
    status: "completed",
    output: "Parser inspected",
  }, ["host_1/grok/child-1"]);
  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.receiverSessionIds, ["host_1/grok/child-1"]);
  assert.equal(finished?.summary, "Parser inspected");

  const statusMissing = normalizeGrokSubagentUpdate({
    sessionUpdate: "subagent_finished",
    child_session_id: "child-unverified",
  });
  assert.equal(statusMissing?.status, "unknown");
  assert.deepEqual(statusMissing?.receiverSessionIds, []);
});

test("Grok replay coalesces spawn and finish without losing spawn metadata", () => {
  const accumulator = createMessageAccumulator();
  const spawnUpdate = {
    sessionUpdate: "subagent_spawned",
    subagent_id: "worker-1",
    description: "Inspect the parser",
    model: "grok-build",
  };
  const finishUpdate = {
    sessionUpdate: "subagent_finished",
    subagent_id: "worker-1",
    status: "completed",
    output: "Parser inspected",
  };
  const spawned = normalizeGrokSubagentUpdate(spawnUpdate);
  const finished = normalizeGrokSubagentUpdate(finishUpdate);
  assert.ok(spawned);
  assert.ok(finished);
  appendAcpSubagentPart("host_1", "parent-1", spawnUpdate, spawned, accumulator);
  appendAcpSubagentPart("host_1", "parent-1", finishUpdate, finished, accumulator);

  const messages = completeAcpMessages(accumulator);
  assert.equal(messages.length, 1);
  const part = messages[0]?.parts[0];
  assert.equal(part?.type, "subagent");
  if (part?.type !== "subagent") return;
  assert.equal(part.status, "completed");
  assert.equal(part.modelId, "grok-build");
  assert.equal(part.summary, "Parser inspected");
});
