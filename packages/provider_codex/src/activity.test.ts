import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionState } from "../../protocol/src/index.js";
import {
  CodexActivityReconciler,
  codexExternalActivityPollMs,
  type CodexObservedMessage,
  type CodexContextObservation,
  type CodexTurnMetadata,
  readLatestRolloutContext,
  readLatestRolloutMarker,
  readLatestRolloutTurnMetadata,
  readRecentRolloutMessages,
} from "./activity.js";
import { externalSessionLaunchesFromCommand, readExternalSessionLaunchesFromRollout } from "./external_launches.js";

test("externally owned Codex output is sampled within half a second", () => {
  assert.equal(codexExternalActivityPollMs, 500);
});

test("explicit OpenCode run commands expose conservative external-session launch evidence", () => {
  const observedAt = "2026-08-22T00:28:59.259Z";
  assert.deepEqual(externalSessionLaunchesFromCommand(
    "& 'C:\\nvm4w\\nodejs\\opencode.ps1' run 'Do the audit' --model deepseek/deepseek-v4-pro --dir 'C:\\work\\audit' --variant max --title 'Audit worker'",
    observedAt,
  ), [{
    targetProviderId: "opencode",
    title: "Audit worker",
    observedAt,
    workingDirectory: "C:\\work\\audit",
    modelId: "deepseek/deepseek-v4-pro",
  }]);
  assert.deepEqual(externalSessionLaunchesFromCommand("opencode run 'human-looking task without an explicit title'", observedAt), []);
  assert.deepEqual(externalSessionLaunchesFromCommand("npm run build --title 'not opencode'", observedAt), []);
});

test("statically-authored OpenCode batch launches expose every literal task without evaluating script code", () => {
  const observedAt = "2026-08-22T02:59:01.567Z";
  const source = `const cli = 'C:\\nvm4w\\nodejs\\opencode.ps1';
const dir = 'C:\\Users\\test\\Documents\\Sample Research';
const tasks = [
  { title:'Sample registration trace', body:'One' },
  { title:'Sample count audit', body:'Two' }
];
const promises = tasks.map(t => {
  const cmd = \`& \${psQuote(cli)} run --model \${psQuote('deepseek/deepseek-v4-flash-vision-exp')} --variant max --dir \${psQuote(dir)} --title \${psQuote(t.title)} \${psQuote(t.body)}\`;
  return tools.exec_command({cmd,workdir:dir});
});`;
  assert.deepEqual(externalSessionLaunchesFromCommand(source, observedAt), [
    { targetProviderId: "opencode", title: "Sample registration trace", observedAt, workingDirectory: "C:\\Users\\test\\Documents\\Sample Research", modelId: "deepseek/deepseek-v4-flash-vision-exp" },
    { targetProviderId: "opencode", title: "Sample count audit", observedAt, workingDirectory: "C:\\Users\\test\\Documents\\Sample Research", modelId: "deepseek/deepseek-v4-flash-vision-exp" },
  ]);
  assert.deepEqual(externalSessionLaunchesFromCommand("const tasks=[{title:'looks like a worker'}]; tools.exec_command({cmd:'echo nope'})", observedAt), []);
});

test("literal cmd1 and cmd2 OpenCode launches retain exact parent provenance", () => {
  const observedAt = "2026-08-22T14:49:22.123Z";
  const source = [
    "const exe='C:\\\\nvm4w\\\\nodejs\\\\opencode.ps1';",
    "const dir='C:\\\\cli_remote';",
    "const cmd1=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --format json --title 'Sample routing audit' '${prompt1.replaceAll(\"'\",\"''\")}'`;",
    "const cmd2=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --format json --title 'Sample payload audit' '${prompt2.replaceAll(\"'\",\"''\")}'`;",
    "const res=await Promise.all([tools.exec_command({cmd:cmd1,workdir:dir}),tools.exec_command({cmd:cmd2,workdir:dir})]);",
  ].join("\n");
  assert.deepEqual(externalSessionLaunchesFromCommand(source, observedAt), [
    { targetProviderId: "opencode", title: "Sample routing audit", observedAt, workingDirectory: "C:\\cli_remote", modelId: "deepseek/deepseek-v4-flash" },
    { targetProviderId: "opencode", title: "Sample payload audit", observedAt, workingDirectory: "C:\\cli_remote", modelId: "deepseek/deepseek-v4-flash" },
  ]);
});

test("literal parallel prompt model and title arrays expose every OpenCode launch at startup time", () => {
  const observedAt = "2026-08-22T13:45:40.000Z";
  const source = [
    'const cwd="C:\\\\Users\\\\test\\\\Documents\\\\Sample Research";',
    'const exe="C:\\\\nvm4w\\\\nodejs\\\\opencode.ps1";',
    'const prompts=[`one bounded prompt`,`two bounded prompt`,`three bounded prompt`];',
    'const models=["deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro","deepseek/deepseek-v4-flash"];',
    'const titles=["Sample Flash final config closure","Sample Pro final density implementation","Sample Flash final vtable closure"];',
    "const calls=prompts.map((p,i)=>tools.exec_command({cmd:`& '${exe}' run --model '${models[i]}' --variant max --dir '${cwd}' --title '${titles[i]}' '${p}'`,workdir:cwd}));",
  ].join("\n");
  assert.deepEqual(externalSessionLaunchesFromCommand(source, observedAt), [
    { targetProviderId: "opencode", title: "Sample Flash final config closure", observedAt, workingDirectory: "C:\\Users\\test\\Documents\\Sample Research", modelId: "deepseek/deepseek-v4-flash" },
    { targetProviderId: "opencode", title: "Sample Pro final density implementation", observedAt, workingDirectory: "C:\\Users\\test\\Documents\\Sample Research", modelId: "deepseek/deepseek-v4-pro" },
    { targetProviderId: "opencode", title: "Sample Flash final vtable closure", observedAt, workingDirectory: "C:\\Users\\test\\Documents\\Sample Research", modelId: "deepseek/deepseek-v4-flash" },
  ]);
  assert.deepEqual(externalSessionLaunchesFromCommand(source.replace('const titles=["Sample Flash final config closure","Sample Pro final density implementation","Sample Flash final vtable closure"];', 'const titles=["only one"];'), observedAt), []);
  assert.deepEqual(externalSessionLaunchesFromCommand(source.replace('titles[i]', 'titles[getIndex()]'), observedAt), []);
});

test("one-file compaction history remains discoverable on a fresh reconciler", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-one-file-compaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const launchSource = "const exe='C:\\\\nvm4w\\\\nodejs\\\\opencode.ps1'; const dir='C:\\\\cli_remote'; const cmd1=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --title 'Sample routing audit' 'one'`; const cmd2=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --title 'Sample payload audit' 'two'`; const calls=Promise.all([tools.exec_command({cmd:cmd1}),tools.exec_command({cmd:cmd2})]);";
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-22T13:42:39.745Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: launchSource } }),
    JSON.stringify({ timestamp: "2026-08-22T13:50:00.000Z", type: "compacted", payload: { window_number: 1, first_window_id: "window-0", previous_window_id: "window-0", window_id: "window-1", message: "summary" } }),
    JSON.stringify({ timestamp: "2026-08-22T14:00:00.000Z", type: "compacted", payload: { window_number: 2, first_window_id: "window-0", previous_window_id: "window-1", window_id: "window-2", message: "summary" } }),
  ].join("\n") + "\n", "utf8");
  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "working" }]);
  assert.deepEqual((await reconciler.externalSessionLaunches("thread-1", "2026-08-22T13:30:00.000Z")).map((launch) => launch.title), [
    "Sample routing audit",
    "Sample payload audit",
  ]);
});

test("durable launch discovery reads nested parallel commands backwards and respects the cutoff", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-launches-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const nested = `const [a,b] = await Promise.all([tools.exec_command({cmd:${JSON.stringify("opencode run 'one' --dir 'C:\\\\work\\\\one' --model deepseek/one --title 'Worker one'")}}),tools.exec_command({cmd:${JSON.stringify("& 'C:\\\\bin\\\\opencode.ps1' run 'two' --dir 'C:\\\\work\\\\two' --model deepseek/two --title 'Worker two'")}})]);`;
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-21T20:00:00.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `tools.exec_command({cmd:${JSON.stringify("opencode run old --dir C:\\\\old --title 'Old worker'")}})` } }),
    JSON.stringify({ timestamp: "2026-08-22T00:28:59.259Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: nested } }),
    JSON.stringify({ timestamp: "2026-08-22T00:29:02.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["pwsh", "-Command", "opencode run 'one' --dir 'C:\\\\work\\\\one' --model deepseek/one --title 'Worker one'"] } } }),
  ].join("\n") + "\n", "utf8");
  const launches = await readExternalSessionLaunchesFromRollout(rollout, "2026-08-22T00:00:00.000Z");
  assert.deepEqual(launches.map((launch) => launch.title), ["Worker one", "Worker two"]);
  assert.equal(launches.some((launch) => launch.title === "Old worker"), false);
});

test("external launch discovery survives a Codex rollout path changing after compaction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-launch-windows-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const beforeCompaction = join(directory, "rollout-before.jsonl");
  const afterCompaction = join(directory, "rollout-after.jsonl");
  await writeFile(beforeCompaction, `${JSON.stringify({
    timestamp: "2026-08-22T00:29:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: `tools.exec_command({cmd:${JSON.stringify("opencode run audit --dir C:\\\\work\\\\audit --model deepseek/flash --title 'Pre-compaction worker'")}})`,
    },
  })}\n`, "utf8");
  await writeFile(afterCompaction, `${JSON.stringify({
    timestamp: "2026-08-22T00:31:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: `tools.exec_command({cmd:${JSON.stringify("opencode run audit --dir C:\\\\work\\\\audit --model deepseek/pro --title 'Post-compaction worker'")}})`,
    },
  })}\n`, "utf8");
  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: beforeCompaction, nativeState: "working" }]);
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: afterCompaction, nativeState: "working" }]);

  const launches = await reconciler.externalSessionLaunches("thread-1", "2026-08-22T00:00:00.000Z");
  assert.deepEqual(launches.map((launch) => launch.title), ["Pre-compaction worker", "Post-compaction worker"]);
});

function line(type: string): string {
  return `${JSON.stringify(type === "turn_context" ? { type } : { type: "event_msg", payload: { type } })}\n`;
}

function turnContext(model: string, effort: string, legacyEffort = false): string {
  return `${JSON.stringify({
    type: "turn_context",
    payload: { model, [legacyEffort ? "reasoning_effort" : "effort"]: effort },
  })}\n`;
}

function tokenCount(total: number, contextWindow: number, input = total - 25, output = 25): string {
  return `${JSON.stringify({
    timestamp: "2026-08-15T13:15:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: Math.max(0, input - 10), output_tokens: output, total_tokens: total },
        model_context_window: contextWindow,
      },
    },
  })}\n`;
}

function messageLine(
  id: string,
  role: "user" | "assistant" | "developer",
  text: string,
  phase?: "commentary" | "final_answer",
): string {
  return `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      ...(phase !== undefined ? { phase } : {}),
    },
  })}\n`;
}

test("recent rollout history returns a bounded safe transcript", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const at = "2026-08-12T12:34:56.000Z";
  const record = (value: Record<string, unknown>) => `${JSON.stringify({ timestamp: at, ...value })}\n`;
  await writeFile(rollout, [
    record({ type: "response_item", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "Earlier question" }] } }),
    record({ type: "response_item", payload: { type: "function_call", id: "secret-tool", arguments: "do not expose" } }),
    record({ type: "response_item", payload: { type: "reasoning", id: "reason-1", summary: [{ type: "summary_text", text: "Checking the implementation" }], encrypted_content: "hidden" } }),
    record({ type: "response_item", payload: { type: "message", id: "assistant-1", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Earlier answer" }] } }),
  ].join(""), "utf8");

  assert.deepEqual(await readRecentRolloutMessages(rollout, 2), [
    { messageId: "reason-1", role: "assistant", text: "Checking the implementation", partType: "reasoning", createdAt: at },
    { messageId: "assistant-1", role: "assistant", text: "Earlier answer", partType: "text", phase: "final_answer", createdAt: at },
  ]);
});

test("recent rollout history keeps bounded Codex tool activity and joins its result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-tool-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const startedAt = "2026-08-21T14:00:00.000Z";
  const completedAt = "2026-08-21T14:00:01.000Z";
  await writeFile(rollout, [
    `${JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "custom_tool_call", id: "item-1", call_id: "call-1", name: "exec", status: "completed", input: 'const r = await tools.exec_command({cmd:"rg -n \\"Reasoning\\" src"}); text(r.output)' } })}\n`,
    `${JSON.stringify({ timestamp: completedAt, type: "response_item", payload: { type: "custom_tool_call_output", id: "item-2", call_id: "call-1", output: "two matches" } })}\n`,
  ].join(""), "utf8");

  assert.deepEqual(await readRecentRolloutMessages(rollout), [{
    messageId: "call-1",
    role: "tool",
    text: "two matches",
    partType: "activity",
    parts: [{ type: "command", command: 'rg -n "Reasoning" src', output: "two matches", status: "completed" }],
    createdAt: startedAt,
  }]);
});

test("pending Codex exec activity exposes exact or raw input immediately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-pending-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const startedAt = "2026-08-21T14:00:00.000Z";
  await writeFile(rollout, [
    `${JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "custom_tool_call", call_id: "call-exact", name: "exec", status: "in_progress", input: 'const r = await tools.exec_command({cmd:"npm test"})' } })}\n`,
    `${JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "custom_tool_call", call_id: "call-raw", name: "exec", status: "in_progress", input: "invoke terminal with the current workspace" } })}\n`,
  ].join(""), "utf8");

  const messages = await readRecentRolloutMessages(rollout);
  assert.deepEqual(messages[0]?.parts, [{ type: "command", command: "npm test", status: "running" }]);
  assert.deepEqual(messages[1]?.parts, [{ type: "command", command: "invoke terminal with the current workspace", status: "running" }]);
  assert.equal(messages.some((message) => message.parts?.some((part) => part.type === "command" && part.command === "Run")), false);
});

test("recent rollout history reads the quoted command and textual Codex output blocks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-real-tool-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const startedAt = "2026-08-21T14:00:00.000Z";
  await writeFile(rollout, [
    `${JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "custom_tool_call", call_id: "call-real", name: "exec", input: 'const r = await tools.exec_command({"cmd":"rg -n \\"Reasoning\\" src","workdir":"C:\\\\repo"}); text(r.output);' } })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-real", output: [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "two matches\n" }] } })}\n`,
  ].join(""), "utf8");

  assert.deepEqual(await readRecentRolloutMessages(rollout), [{
    messageId: "call-real",
    role: "tool",
    text: "Script completed\ntwo matches",
    partType: "activity",
    parts: [{ type: "command", command: 'rg -n "Reasoning" src', output: "Script completed\ntwo matches", status: "completed" }],
    createdAt: startedAt,
  }]);
});

test("recent rollout history preserves compaction detail as a dedicated part", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-compaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const at = "2026-08-21T12:34:56.000Z";
  const detail = "Another language model started to solve this problem and produced a summary of its thinking process.\n\n## Current task progress\n\nKeep this hidden until expanded.";
  await writeFile(rollout, `${JSON.stringify({ timestamp: at, type: "compacted", payload: { message: detail, replacement_history: [{ secret: "not flattened" }] } })}\n`, "utf8");

  assert.deepEqual(await readRecentRolloutMessages(rollout), [{
    messageId: `compaction-${at}`,
    role: "assistant",
    text: detail,
    partType: "compaction",
    phase: "commentary",
    createdAt: at,
  }]);
});

test("recent rollout history hides fallback response guidance from user text", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-guidance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, messageLine("user-guided", "user", "<tethoq_response_guidance>\nKeep it concise.\n</tethoq_response_guidance>\n\nVisible request"), "utf8");
  assert.equal((await readRecentRolloutMessages(rollout))[0]?.text, "Visible request");
});

test("recent rollout history removes Codex attachment chrome and retains its image", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-attachment-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const at = "2026-08-15T12:34:56.000Z";
  await writeFile(rollout, `${JSON.stringify({
    timestamp: at,
    type: "response_item",
    payload: {
      type: "message",
      id: "user-with-image",
      role: "user",
      content: [
        { type: "input_text", text: "\n# Files mentioned by the user:\n\n## screenshot.png: C:/Users/person/AppData/Local/Temp/screenshot.png\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nPlease match this layout.\n" },
        { type: "input_text", text: '<image name=[Image #1] path="C:\\Users\\person\\AppData\\Local\\Temp\\screenshot.png">' },
        { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "original" },
        { type: "input_text", text: "</image>" },
      ],
    },
  })}\n`, "utf8");

  assert.deepEqual(await readRecentRolloutMessages(rollout), [{
    messageId: "user-with-image",
    role: "user",
    text: "Please match this layout.",
    partType: "text",
    parts: [
      { type: "text", text: "Please match this layout." },
      { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "screenshot.png" },
    ],
    createdAt: at,
  }]);
});

test("rollout activity uses the latest control marker and tolerates an incomplete final line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-activity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");

  await writeFile(rollout, `${line("task_started")}{"type":`, "utf8");
  assert.equal(await readLatestRolloutMarker(rollout), "started");

  await writeFile(rollout, `${line("task_started")}${line("turn_aborted")}`, "utf8");
  assert.equal(await readLatestRolloutMarker(rollout), "terminal");
});

test("rollout activity reads the latest exact model and effort across tail chunks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, [
    turnContext("gpt-old", "low"),
    `${JSON.stringify({ type: "response_item", payload: { output: "x".repeat(1_024) } })}\n`,
    turnContext("gpt-current", "high", true),
    `${JSON.stringify({ type: "response_item", payload: { output: "y".repeat(1_024) } })}\n`,
  ].join(""), "utf8");

  assert.deepEqual(await readLatestRolloutTurnMetadata(rollout, 128), {
    modelId: "gpt-current",
    reasoningEffort: "high",
  });
});

test("rollout activity reports the latest bounded context usage and live changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const changes: Array<[string, CodexContextObservation]> = [];
  await writeFile(rollout, `${line("task_started")}${tokenCount(399_748, 1_000_000)}`, "utf8");

  assert.deepEqual(await readLatestRolloutContext(rollout, 128), {
    usedTokens: 399_748,
    contextWindowTokens: 1_000_000,
    inputTokens: 399_723,
    outputTokens: 25,
    cacheReadTokens: 399_713,
    totalTokens: 399_748,
    updatedAt: "2026-08-15T13:15:00.000Z",
  });

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
    onContextChanged: (threadId, context) => { changes.push([threadId, context]); },
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);
  assert.equal(reconciler.context("thread-1")?.usedTokens, 399_748);
  assert.deepEqual([...changes], [], "initial context is returned with the session rather than replayed");

  await appendFile(rollout, tokenCount(410_000, 1_000_000), "utf8");
  await reconciler.pollNow();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.[0], "thread-1");
  assert.equal(changes[0]?.[1].usedTokens, 410_000);
});

test("rollout activity baselines runtime metadata and reports appended context changes once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const changes: Array<[string, CodexTurnMetadata]> = [];
  await writeFile(rollout, turnContext("gpt-5.6-sol", "medium"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
    onTurnMetadataChanged: (threadId, metadata) => { changes.push([threadId, metadata]); },
  });
  t.after(() => reconciler.dispose());

  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);
  assert.deepEqual(reconciler.turnMetadata("thread-1"), { modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  assert.deepEqual(changes, [], "initial history is returned with the session rather than replayed as an event");

  await appendFile(rollout, turnContext("gpt-5.6-sol", "high"), "utf8");
  await reconciler.pollNow();
  await appendFile(rollout, turnContext("gpt-5.6-sol", "high"), "utf8");
  await reconciler.pollNow();
  assert.deepEqual(changes, [["thread-1", { modelId: "gpt-5.6-sol", reasoningEffort: "high" }]]);
});

test("native working and idle threads keep observing exact metadata without replaying messages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-native-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const metadataChanges: Array<[string, CodexTurnMetadata]> = [];
  const observed: CodexObservedMessage[] = [];
  await writeFile(rollout, `${turnContext("gpt-initial", "medium")}${messageLine("old", "assistant", "historical")}`, "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
    onMessage: (_threadId, message) => { observed.push(message); },
    onTurnMetadataChanged: (threadId, metadata) => { metadataChanges.push([threadId, metadata]); },
  });
  t.after(() => reconciler.dispose());

  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "working" }]);
  assert.deepEqual(reconciler.turnMetadata("thread-1"), { modelId: "gpt-initial", reasoningEffort: "medium" });
  assert.deepEqual(metadataChanges, []);

  await appendFile(rollout, `${messageLine("assistant-1", "assistant", "native owns this")}${turnContext("gpt-working", "high", true)}`, "utf8");
  await reconciler.pollNow();
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);
  await appendFile(rollout, turnContext("gpt-idle", "low"), "utf8");
  await reconciler.pollNow();

  assert.deepEqual(metadataChanges, [
    ["thread-1", { modelId: "gpt-working", reasoningEffort: "high" }],
    ["thread-1", { modelId: "gpt-idle", reasoningEffort: "low" }],
  ]);
  assert.deepEqual(observed, []);
});

test("truncated active tails use the writer lock while terminal markers remain idle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-activity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const changes: Array<[string, SessionState]> = [];
  let lockHeld = true;
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    tailBytes: 128,
    isLockHeld: async () => lockHeld,
    onStateChanged: (threadId, state) => { changes.push([threadId, state]); },
  });
  t.after(() => reconciler.dispose());

  await writeFile(rollout, `${line("task_started")}${JSON.stringify({ type: "response_item", payload: { output: "x".repeat(1_024) } })}\n`, "utf8");
  let states = await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-1"), "working");

  lockHeld = false;
  await reconciler.pollNow();
  assert.deepEqual(changes, [["thread-1", "idle"]]);

  await writeFile(rollout, `${line("task_started")}${line("task_complete")}`, "utf8");
  lockHeld = true;
  await reconciler.pollNow();
  assert.deepEqual(changes, [["thread-1", "idle"]], "a held lock cannot override a terminal marker");

  states = await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "failed" }]);
  assert.equal(states.get("thread-1"), "failed", "native failure remains authoritative");
});

test("missing, relative, and unreadable rollout paths remain unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-activity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());

  const states = await reconciler.reconcile([
    { providerSessionId: "missing", path: join(directory, "missing.jsonl"), nativeState: "unknown" },
    { providerSessionId: "relative", path: "rollout.jsonl", nativeState: "unknown" },
  ]);
  assert.equal(states.get("missing"), "unknown");
  assert.equal(states.get("relative"), "unknown");
});

test("active thread discovery is bounded to real Codex UUID lock files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  await mkdir(lockDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(lockDirectory, "019ffeab-3a74-7140-87f2-cd348d5ee856.lock"), ""),
    writeFile(join(lockDirectory, ".coordination.lock"), ""),
    writeFile(join(lockDirectory, "not-a-session.lock"), ""),
  ]);
  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());
  assert.deepEqual(await reconciler.activeThreadIds(), ["019ffeab-3a74-7140-87f2-cd348d5ee856"]);
});

test("writer-lock lookup is path-safe and reports lock removal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-writer-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const lockPath = join(lockDirectory, `${threadId}.lock`);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(lockPath, "");
  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());

  assert.equal(await reconciler.hasWriterLock(threadId), true);
  assert.equal(await reconciler.hasWriterLock("..\\outside"), false);
  await rm(lockPath);
  assert.equal(await reconciler.hasWriterLock(threadId), false);
});

test("rollout observer skips history and emits only newly appended user-visible messages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-messages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const observed: Array<[string, CodexObservedMessage]> = [];
  await writeFile(rollout, `${line("task_started")}${messageLine("old", "assistant", "historical", "commentary")}`, "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
    onMessage: (threadId, message) => { observed.push([threadId, message]); },
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);
  await reconciler.pollNow();
  assert.deepEqual(observed, [], "registration must not replay existing transcript records");

  await appendFile(rollout, [
    messageLine("user-1", "user", "new user text"),
    messageLine("assistant-1", "assistant", "new assistant text", "commentary"),
    `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", id: "reasoning-1", summary: [{ type: "summary_text", text: "safe summary" }], encrypted_content: "ignored ciphertext" } })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", id: "reasoning-empty", summary: [], encrypted_content: "reasoning secret" } })}\n`,
    messageLine("developer-1", "developer", "developer secret"),
    `${JSON.stringify({ type: "response_item", payload: { type: "agent_message", message: "duplicate secret", encrypted_content: "ciphertext" } })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "shell", arguments: "tool secret" } })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", id: "tool-safe", call_id: "call-safe", name: "view_image", status: "completed", input: "preview.png" } })}\n`,
    `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", id: "tool-safe-output", call_id: "call-safe", output: "image opened" } })}\n`,
    `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "event duplicate" } })}\n`,
  ].join(""), "utf8");
  await reconciler.pollNow();

  assert.deepEqual(observed, [
    ["thread-1", { messageId: "user-1", role: "user", text: "new user text", partType: "text", parts: [{ type: "text", text: "new user text" }] }],
    ["thread-1", { messageId: "assistant-1", role: "assistant", text: "new assistant text", partType: "text", phase: "commentary" }],
    ["thread-1", { messageId: "reasoning-1", role: "assistant", text: "safe summary", partType: "reasoning" }],
    ["thread-1", { messageId: "call-safe", role: "tool", text: "preview.png", partType: "activity", parts: [{ type: "tool", name: "view_image", callId: "call-safe", input: "preview.png", status: "completed" }] }],
    ["thread-1", { messageId: "call-safe", role: "tool", text: "image opened", partType: "activity", parts: [{ type: "tool", name: "view_image", callId: "call-safe", input: "preview.png", output: "image opened", status: "completed" }] }],
  ]);
  assert.equal(JSON.stringify(observed).includes("secret"), false, "unsafe rollout payloads must never escape the observer");
});

test("rollout observer waits for a complete appended JSONL record and stops after dispose", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-messages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const observed: CodexObservedMessage[] = [];
  await writeFile(rollout, line("task_started"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
    onMessage: (_threadId, message) => { observed.push(message); },
  });
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);

  const appended = messageLine("assistant-1", "assistant", "split safely", "final_answer");
  const splitAt = Math.floor(appended.length / 2);
  await appendFile(rollout, appended.slice(0, splitAt), "utf8");
  await reconciler.pollNow();
  assert.deepEqual(observed, []);
  await appendFile(rollout, appended.slice(splitAt), "utf8");
  await reconciler.pollNow();
  assert.deepEqual(observed, [{ messageId: "assistant-1", role: "assistant", text: "split safely", partType: "text", phase: "final_answer" }]);

  reconciler.dispose();
  await appendFile(rollout, messageLine("assistant-2", "assistant", "after dispose"), "utf8");
  await reconciler.pollNow();
  assert.equal(observed.length, 1);
});

test("native thread state disables rollout message observation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-messages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const observed: CodexObservedMessage[] = [];
  await writeFile(rollout, line("task_started"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
    onMessage: (_threadId, message) => { observed.push(message); },
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "unknown" }]);
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "working" }]);
  await appendFile(rollout, messageLine("assistant-1", "assistant", "native owns this"), "utf8");
  await reconciler.pollNow();
  assert.deepEqual(observed, []);
});
