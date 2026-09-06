import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DelegationTask } from "../../../packages/protocol/src/index.js";
import { DelegationStateStore } from "./delegation_store.js";

test("delegation state survives a bridge restart without losing child linkage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-delegations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "delegations.json");
  const task: DelegationTask = {
    id: "delegation-one",
    parentSessionId: "session-parent",
    prompt: "Review the implementation",
    state: "working",
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:01.000Z",
    children: [{
      id: "child-one",
      providerId: "grok",
      sessionId: "session-child",
      modelId: "grok-4.5",
      reasoningEffort: "high",
      state: "working",
    }],
  };
  const writer = new DelegationStateStore(path);
  writer.scheduleWrite([task]);
  await writer.flush();

  const restored = await new DelegationStateStore(path).read();
  assert.deepEqual(restored.tasks, [task]);
});

test("prepared parent Mesh state preserves authorization and inline presentation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-prepared-delegation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "delegations.json");
  const task: DelegationTask = {
    id: "mesh-request-one",
    parentSessionId: "host/codex/parent",
    prompt: "Ask  to review this.",
    state: "awaiting_dispatch",
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    children: [],
    orchestration: "parent",
    targets: [{ providerId: "opencode", modelId: "deepseek/deepseek-v4", reasoningEffort: "high" }],
    presentationSegments: [
      { type: "text", text: "Ask " },
      { type: "mesh", targetIndex: 0 },
      { type: "text", text: " to review this." },
    ],
    parentModelId: "gpt-5.6-sol",
    parentReasoningEffort: "high",
  };
  const writer = new DelegationStateStore(path);
  writer.scheduleWrite([task]);
  await writer.flush();

  assert.deepEqual((await new DelegationStateStore(path).read()).tasks, [task]);
});
