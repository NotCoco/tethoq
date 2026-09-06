import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  readAllRolloutMessages,
  readRecentRolloutMessages,
} from "./activity.js";
import { externalSessionLaunchesFromCommand, readExternalSessionLaunchesFromRollout } from "./external_launches.js";

test("externally owned Codex output is sampled within half a second", () => {
  assert.equal(codexExternalActivityPollMs, 500);
});

test("explicit OpenCode run commands expose conservative external-session launch evidence", () => {
  const observedAt = "2026-08-22T00:28:59.259Z";
  assert.deepEqual(externalSessionLaunchesFromCommand(
    "& 'C:\\tools\\nodejs\\opencode.ps1' run 'Do the audit' --model deepseek/deepseek-v4-pro --dir 'C:\\work\\audit' --variant max --title 'Audit worker'",
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
  const source = `const cli = 'C:\\tools\\nodejs\\opencode.ps1';
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
    "const exe='C:\\\\tools\\\\nodejs\\\\opencode.ps1';",
    "const dir='C:\\\\example-repo';",
    "const cmd1=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --format json --title 'Sample routing audit' '${prompt1.replaceAll(\"'\",\"''\")}'`;",
    "const cmd2=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --format json --title 'Sample payload audit' '${prompt2.replaceAll(\"'\",\"''\")}'`;",
    "const res=await Promise.all([tools.exec_command({cmd:cmd1,workdir:dir}),tools.exec_command({cmd:cmd2,workdir:dir})]);",
  ].join("\n");
  assert.deepEqual(externalSessionLaunchesFromCommand(source, observedAt), [
    { targetProviderId: "opencode", title: "Sample routing audit", observedAt, workingDirectory: "C:\\example-repo", modelId: "deepseek/deepseek-v4-flash" },
    { targetProviderId: "opencode", title: "Sample payload audit", observedAt, workingDirectory: "C:\\example-repo", modelId: "deepseek/deepseek-v4-flash" },
  ]);
});

test("literal parallel prompt model and title arrays expose every OpenCode launch at startup time", () => {
  const observedAt = "2026-08-22T13:45:40.000Z";
  const source = [
    'const cwd="C:\\\\Users\\\\test\\\\Documents\\\\Sample Research";',
    'const exe="C:\\\\tools\\\\nodejs\\\\opencode.ps1";',
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
  const launchSource = "const exe='C:\\\\tools\\\\nodejs\\\\opencode.ps1'; const dir='C:\\\\example-repo'; const cmd1=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --title 'Sample routing audit' 'one'`; const cmd2=`& '${exe}' run --model 'deepseek/deepseek-v4-flash' --variant max --dir '${dir}' --title 'Sample payload audit' 'two'`; const calls=Promise.all([tools.exec_command({cmd:cmd1}),tools.exec_command({cmd:cmd2})]);";
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

function ordinalLine(ordinal: number, value: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp: "2026-09-03T01:00:00.000Z", ordinal, ...value })}\n`;
}

test("physical history_base continuations preserve ordered messages and attachments across every reader", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-codex-history-base-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseThreadId = "01a05f50-de80-7540-8af4-3226349adaad";
  const threadId = "01a06050-a7a5-7db1-964b-887352f17348";
  const original = join(directory, `rollout-2026-09-02T00-32-10-${baseThreadId}.jsonl`);
  const continuation = join(directory, `rollout-2026-09-02T05-11-33-${threadId}_writer.jsonl`);
  const imageUri = `data:image/png;base64,${Buffer.alloc(1_550_000).toString("base64")}`;
  const originalPrefix = [
    ordinalLine(0, { type: "session_meta", payload: { session_id: baseThreadId, id: baseThreadId } }),
    ordinalLine(1, { type: "response_item", payload: {
      type: "message", id: "old-user", role: "user", content: [
        { type: "input_text", text: "Old question with proof" },
        { type: "input_image", image_url: imageUri, detail: "original" },
      ],
    } }),
    ordinalLine(2, { type: "response_item", payload: {
      type: "message", id: "old-final", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "Old answer" }],
    } }),
  ].join("");
  const cutoff = Buffer.byteLength(originalPrefix, "utf8");
  await writeFile(original, originalPrefix + ordinalLine(3, { type: "response_item", payload: {
    type: "message", id: "excluded-overlap", role: "user", content: [{ type: "input_text", text: "Must not leak" }],
  } }), "utf8");
  await writeFile(continuation, [
    ordinalLine(3, { type: "session_meta", payload: {
      session_id: threadId,
      id: threadId,
      history_base: { thread_id: baseThreadId, end_ordinal_exclusive: 3, end_byte_offset: cutoff },
    } }),
    ordinalLine(4, { type: "response_item", payload: {
      type: "message", id: "new-user", role: "user", content: [{ type: "input_text", text: "New question" }],
    } }),
    ordinalLine(5, { type: "response_item", payload: {
      type: "message", id: "new-final", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "New answer" }],
    } }),
  ].join(""), "utf8");
  assert.ok(cutoff > 2_000_000, "fixture must exercise a multi-megabyte JSONL record");

  const expectedIds = ["old-user", "old-final", "new-user", "new-final"];
  for (const messages of [
    await readRecentRolloutMessages(continuation, 20, 4 * 1024 * 1024),
    await readAllRolloutMessages(continuation),
  ]) {
    assert.deepEqual(messages.map((message) => message.messageId), expectedIds);
    assert.equal(messages.filter((message) => message.messageId === "old-user").length, 1);
    assert.equal(messages[0]?.parts?.some((part) => part.type === "image" && part.uri === imageUri), true);
    assert.equal(messages.some((message) => message.messageId === "excluded-overlap"), false);
  }

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    historyBytes: 256 * 1024,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: threadId, path: continuation, nativeState: "idle" }]);
  let page = await reconciler.recentMessageWindow(threadId);
  assert.ok(page);
  assert.equal(page.complete, false, "the continuation tail cannot claim completeness before crossing its base cutoff");
  assert.match(page.olderCursor ?? "", /^codex-rollout-byte:v2:/u);
  let combined = [...page.messages];
  for (let attempt = 0; attempt < 20 && !page.complete; attempt += 1) {
    assert.ok(page.olderCursor, "every known older physical boundary remains reachable");
    page = (await reconciler.olderMessageWindow(threadId, page.olderCursor))!;
    assert.ok(page);
    const existing = new Set(page.messages.map((message) => `${message.role}\0${message.partType}\0${message.messageId}`));
    combined = [...page.messages, ...combined.filter((message) => !existing.has(`${message.role}\0${message.partType}\0${message.messageId}`))];
  }
  assert.equal(page.complete, true);
  assert.deepEqual(combined.map((message) => message.messageId), expectedIds);
  assert.equal(combined.filter((message) => message.messageId === "old-user").length, 1);
  assert.equal(combined[0]?.parts?.some((part) => part.type === "image" && part.uri === imageUri), true);
  assert.deepEqual((await reconciler.allMessages(threadId)).map((message) => message.messageId), expectedIds);
});

test("missing malformed and cyclic history_base chains terminate without false completeness or duplicate rows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-codex-history-base-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const threadId = "01a05f50-de80-7540-8af4-3226349adbad";
  const missing = join(directory, `rollout-missing-${threadId}_writer.jsonl`);
  await writeFile(missing, [
    ordinalLine(2, { type: "session_meta", payload: { session_id: threadId, history_base: {
      thread_id: threadId, end_ordinal_exclusive: 2, end_byte_offset: 123,
    } } }),
    ordinalLine(3, { type: "response_item", payload: {
      type: "message", id: "missing-current", role: "user", content: [{ type: "input_text", text: "Still visible" }],
    } }),
  ].join(""), "utf8");

  const malformed = join(directory, `rollout-malformed-${threadId}_writer.jsonl`);
  await writeFile(malformed, [
    ordinalLine(2, { type: "session_meta", payload: { session_id: threadId, history_base: {
      thread_id: threadId, end_ordinal_exclusive: 2, end_byte_offset: "not-a-byte-offset",
    } } }),
    ordinalLine(3, { type: "response_item", payload: {
      type: "message", id: "malformed-current", role: "user", content: [{ type: "input_text", text: "Still visible" }],
    } }),
  ].join(""), "utf8");

  const cyclic = join(directory, "rollout-cycle-current.jsonl");
  const cyclicAlias = join(directory, `rollout-cycle-base-${threadId}.jsonl`);
  const cycleMessage = ordinalLine(1, { type: "response_item", payload: {
    type: "message", id: "cycle-current", role: "user", content: [{ type: "input_text", text: "Only once" }],
  } });
  let cycleOffset = 0;
  let cycleContent = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cycleContent = ordinalLine(2, { type: "session_meta", payload: { session_id: threadId, history_base: {
      thread_id: threadId, end_ordinal_exclusive: 2, end_byte_offset: cycleOffset,
    } } }) + cycleMessage;
    const next = Buffer.byteLength(cycleContent, "utf8");
    if (next === cycleOffset) break;
    cycleOffset = next;
  }
  await writeFile(cyclic, cycleContent, "utf8");
  await link(cyclic, cyclicAlias);

  const gapBaseThreadId = "01a05f50-de80-7540-8af4-3226349adcae";
  const gapThreadId = "01a05f50-de80-7540-8af4-3226349adcad";
  const gapBase = join(directory, `rollout-gap-base-${gapBaseThreadId}.jsonl`);
  const gapBaseContent = [
    ordinalLine(0, { type: "session_meta", payload: { session_id: gapBaseThreadId } }),
    ordinalLine(1, { type: "response_item", payload: {
      type: "message", id: "gap-base", role: "user", content: [{ type: "input_text", text: "Must remain unreachable" }],
    } }),
  ].join("");
  await writeFile(gapBase, gapBaseContent, "utf8");
  const discontinuous = join(directory, `rollout-gap-current-${gapThreadId}.jsonl`);
  await writeFile(discontinuous, [
    ordinalLine(3, { type: "session_meta", payload: { session_id: gapThreadId, history_base: {
      thread_id: gapBaseThreadId,
      end_ordinal_exclusive: 2,
      end_byte_offset: Buffer.byteLength(gapBaseContent, "utf8"),
    } } }),
    ordinalLine(4, { type: "response_item", payload: {
      type: "message", id: "gap-current", role: "user", content: [{ type: "input_text", text: "Still visible" }],
    } }),
  ].join(""), "utf8");

  assert.deepEqual((await readAllRolloutMessages(missing)).map((message) => message.messageId), ["missing-current"]);
  assert.deepEqual((await readAllRolloutMessages(malformed)).map((message) => message.messageId), ["malformed-current"]);
  assert.deepEqual((await readAllRolloutMessages(cyclic)).map((message) => message.messageId), ["cycle-current"]);
  assert.deepEqual((await readAllRolloutMessages(discontinuous)).map((message) => message.messageId), ["gap-current"]);

  for (const [path, expected] of [
    [missing, "missing-current"],
    [malformed, "malformed-current"],
    [cyclic, "cycle-current"],
    [discontinuous, "gap-current"],
  ] as const) {
    const reconciler = new CodexActivityReconciler({ codexHome: directory, pollIntervalMs: 60_000, onStateChanged: () => undefined });
    await reconciler.reconcile([{ providerSessionId: threadId, path, nativeState: "idle" }]);
    const recent = await reconciler.recentMessageWindow(threadId);
    assert.deepEqual(recent?.messages.map((message) => message.messageId), [expected]);
    assert.equal(recent?.complete, false);
    assert.equal(recent?.olderCursor, undefined);
    await reconciler.dispose();
  }
});

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

test("the default recent window reaches a previous turn behind a large active turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-deep-recent-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const noise = "x".repeat(128 * 1_024);
  await writeFile(rollout, [
    messageLine("previous-user", "user", "Previous question"),
    messageLine("previous-final", "assistant", "Previous final", "final_answer"),
    ...Array.from({ length: 80 }, (_, index) => `${JSON.stringify({
      type: "event_msg",
      payload: { type: "test_noise", index, noise },
    })}\n`),
    messageLine("current-user", "user", "Current long-running question"),
  ].join(""), "utf8");

  const messages = await readRecentRolloutMessages(rollout);
  assert.deepEqual(messages.filter((message) => message.role === "user" || message.phase === "final_answer").map((message) => message.messageId), [
    "previous-user",
    "previous-final",
    "current-user",
  ]);
});

test("progressive rollout history advances two bounded byte windows without losing boundary metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-progressive-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const record = (timestamp: string, value: Record<string, unknown>) => `${JSON.stringify({ timestamp, ...value })}\n`;
  const noise = (id: string) => record("2026-08-25T09:00:00.000Z", {
    type: "event_msg",
    payload: { type: "test_noise", id, text: "x".repeat(2_200) },
  });
  await writeFile(rollout, [
    record("2026-08-25T09:00:01.000Z", { type: "response_item", payload: {
      type: "message",
      id: "old-user",
      role: "user",
      content: [
        { type: "input_text", text: "Old question" },
        { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "original" },
      ],
    } }),
    noise("old-gap"),
    record("2026-08-25T09:00:02.000Z", { type: "response_item", payload: {
      type: "message", id: "middle-user", role: "user", content: [{ type: "input_text", text: "Middle question" }],
    } }),
    record("2026-08-25T09:00:03.000Z", { type: "response_item", payload: {
      type: "function_call", id: "tool-item", call_id: "boundary-tool", name: "view_image", arguments: "old.png",
    } }),
    noise("middle-gap"),
    record("2026-08-25T09:00:04.000Z", { type: "response_item", payload: {
      type: "function_call_output", id: "tool-output", call_id: "boundary-tool", output: "image opened",
    } }),
    record("2026-08-25T09:00:05.000Z", { type: "response_item", payload: {
      type: "message", id: "new-user", role: "user", content: [{ type: "input_text", text: "Newest question" }],
    } }),
    record("2026-08-25T09:00:06.000Z", { type: "response_item", payload: {
      type: "message", id: "new-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Newest answer" }],
    } }),
  ].join(""), "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    historyBytes: 2_048,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);

  const recent = await reconciler.recentMessageWindow("thread-1");
  assert.ok(recent);
  assert.equal(recent.complete, false);
  assert.ok(recent.olderCursor);
  assert.deepEqual(recent.messages.filter((message) => message.role !== "tool").map((message) => message.messageId), ["new-user", "new-final"]);

  const firstOlder = await reconciler.olderMessageWindow("thread-1", recent.olderCursor!);
  assert.ok(firstOlder);
  assert.equal(firstOlder.complete, false);
  assert.ok(firstOlder.olderCursor);
  assert.notEqual(firstOlder.olderCursor, recent.olderCursor);
  assert.equal(firstOlder.messages.filter((message) => message.messageId === "boundary-tool").length, 1);
  assert.deepEqual(firstOlder.messages.find((message) => message.messageId === "boundary-tool")?.parts, [{
    type: "tool", name: "view_image", callId: "boundary-tool", input: "old.png", output: "image opened", status: "completed",
  }]);

  const secondOlder = await reconciler.olderMessageWindow("thread-1", firstOlder.olderCursor!);
  assert.ok(secondOlder);
  assert.equal(secondOlder.complete, true);
  assert.equal(secondOlder.olderCursor, undefined);
  assert.deepEqual(secondOlder.messages.map((message) => message.messageId), [
    "old-user", "middle-user", "boundary-tool", "new-user", "new-final",
  ]);
  const oldUser = secondOlder.messages[0]!;
  assert.equal(oldUser.parts?.some((part) => part.type === "image" && part.uri === "data:image/png;base64,AQID"), true);
  assert.equal(secondOlder.messages.at(-1)?.phase, "final_answer");
});

test("concurrent recent-history opens share one bounded rollout read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-progressive-inflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, messageLine("only-message", "user", "Open this once"), "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);

  const firstRead = reconciler.recentMessageWindow("thread-1");
  const secondRead = reconciler.recentMessageWindow("thread-1");
  const [first, second] = await Promise.all([firstRead, secondRead]);

  assert.ok(first);
  assert.equal(first, second, "two opens arriving together must share the in-flight bounded result");
});

test("recent history refreshes a page cached before a scheduled user turn was watched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-scheduled-history-gap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({
    timestamp: "2026-08-29T17:18:01.369Z",
    type: "session_meta",
    payload: { session_id: "scheduled-thread" },
  })}\n`, "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    historyBytes: 4_096,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "scheduled-thread", path: rollout, nativeState: "idle" }]);

  const pending = await reconciler.recentMessageWindow("scheduled-thread");
  assert.ok(pending);
  assert.equal(pending.complete, true);
  assert.deepEqual(pending.messages, []);

  const scheduledPrompt = "Run this exact scheduled task";
  await appendFile(rollout, [
    `${JSON.stringify({
      timestamp: "2026-08-29T17:18:03.084Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "native-user-item",
        role: "user",
        content: [{ type: "input_text", text: scheduledPrompt }],
        internal_chat_message_metadata_passthrough: { turn_id: "scheduled-turn" },
      },
    })}\n`,
    `${JSON.stringify({
      timestamp: "2026-08-29T17:18:03.084Z",
      type: "event_msg",
      payload: { type: "user_message", client_id: "schedule-request", message: scheduledPrompt },
    })}\n`,
  ].join(""), "utf8");

  // Watching begins after Codex persisted the user row, so incremental polling
  // deliberately establishes its baseline after that row and cannot replay it.
  await reconciler.watchSession("scheduled-thread");
  await appendFile(rollout, [
    messageLine("scheduled-final", "assistant", "SCHEDULED_OK_CODEX", "final_answer"),
    `${JSON.stringify({
      timestamp: "2026-08-29T17:18:27.809Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "scheduled-turn", last_agent_message: "SCHEDULED_OK_CODEX" },
    })}\n`,
  ].join(""), "utf8");
  await reconciler.pollNow("scheduled-thread");

  const completed = await reconciler.recentMessageWindow("scheduled-thread");
  assert.ok(completed);
  assert.equal(completed.complete, true);
  assert.deepEqual(completed.messages.map((message) => ({
    id: message.messageId,
    role: message.role,
    text: message.text,
  })), [
    { id: "schedule-request", role: "user", text: scheduledPrompt },
    { id: "scheduled-final", role: "assistant", text: "SCHEDULED_OK_CODEX" },
  ]);
});

test("recent history pages backward across an invisible multi-page tail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-invisible-recent-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const invisible = (id: string) => `${JSON.stringify({
    type: "event_msg",
    payload: { type: "provider_metadata", id, text: "x".repeat(1_500) },
  })}\n`;
  await writeFile(rollout, [
    invisible("older-prefix"),
    messageLine("visible-user", "user", "Visible question behind the metadata tail"),
    ...Array.from({ length: 5 }, (_, index) => invisible(`tail-${index}`)),
  ].join(""), "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    historyBytes: 1_024,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);

  const recent = await reconciler.recentMessageWindow("thread-1");
  assert.ok(recent);
  assert.deepEqual(recent.messages.map((message) => message.messageId), ["visible-user"]);
  assert.equal(recent.complete, false, "the bounded walk must stop after finding visible history");
  assert.ok(recent.olderCursor, "older invisible bytes remain pageable without a complete-history rebuild");
});

test("progressive rollout history advances across a byte page with no renderable records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-progressive-empty-page-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, [
    messageLine("old-user", "user", "Old question"),
    `${JSON.stringify({ type: "event_msg", payload: { type: "test_noise", text: "x".repeat(2_500) } })}\n`,
    messageLine("new-user", "user", "Newest question"),
  ].join(""), "utf8");

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    historyBytes: 1_024,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);

  const recent = await reconciler.recentMessageWindow("thread-1");
  assert.ok(recent);
  assert.deepEqual(recent.messages.map((message) => message.messageId), ["new-user"]);
  assert.ok(recent.olderCursor);

  const emptyOlder = await reconciler.olderMessageWindow("thread-1", recent.olderCursor!);
  assert.ok(emptyOlder);
  assert.deepEqual(emptyOlder.messages.map((message) => message.messageId), ["new-user"]);
  assert.ok(emptyOlder.olderCursor);
  assert.notEqual(emptyOlder.olderCursor, recent.olderCursor);

  let expanded = emptyOlder;
  for (let page = 0; page < 4 && expanded.complete === false; page += 1) {
    assert.ok(expanded.olderCursor);
    expanded = (await reconciler.olderMessageWindow("thread-1", expanded.olderCursor!))!;
  }
  assert.equal(expanded.complete, true);
  assert.deepEqual(expanded.messages.map((message) => message.messageId), ["old-user", "new-user"]);
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

test("rollout history keeps Codex function-call activity without App Server enrichment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-function-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const startedAt = "2026-08-25T07:00:00.000Z";
  await writeFile(rollout, [
    `${JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "function_call", id: "item-1", call_id: "call-1", name: "wait_agent", arguments: JSON.stringify({ timeout_ms: 30_000 }) } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-25T07:00:01.000Z", type: "response_item", payload: { type: "function_call_output", id: "item-2", call_id: "call-1", output: "Worker finished" } })}\n`,
  ].join(""), "utf8");

  assert.deepEqual(await readAllRolloutMessages(rollout), [{
    messageId: "call-1",
    role: "tool",
    text: "Worker finished",
    partType: "activity",
    parts: [{ type: "tool", name: "wait_agent", callId: "call-1", input: JSON.stringify({ timeout_ms: 30_000 }), output: "Worker finished", status: "completed" }],
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

test("a Codex compaction handoff is never exposed as a completed final answer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-compaction-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const handoff = `## Handoff summary\n\n${"The active task must continue after context compaction. ".repeat(4).trim()}`;
  const finalWithPresentationMetadata = `${handoff}\n\n<oai-mem-citation>private presentation metadata</oai-mem-citation>`;
  const compacted = `Another language model started to solve this problem and produced a summary of its thinking process.\n\nYou also have access to the state of the tools.\n\n${handoff}`;
  await writeFile(rollout, [
    `${JSON.stringify({ timestamp: "2026-08-28T22:00:15.913Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-live" } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:00:16.106Z", type: "response_item", payload: { type: "message", id: "user-live", role: "user", content: [{ type: "input_text", text: "Keep working" }] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.056Z", type: "response_item", payload: { type: "message", id: "internal-handoff", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: finalWithPresentationMetadata }] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.138Z", type: "event_msg", payload: { type: "token_count", info: {} } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.154Z", type: "compacted", payload: { message: compacted, replacement_history: [] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:09.780Z", type: "response_item", payload: { type: "reasoning", id: "reasoning-after", summary: [{ type: "summary_text", text: "Reasoning continued after compaction" }] } })}\n`,
  ].join(""), "utf8");

  for (const messages of [await readRecentRolloutMessages(rollout), await readAllRolloutMessages(rollout)]) {
    assert.equal(messages.some((message) => message.phase === "final_answer"), false, "the internal handoff cannot become terminal evidence");
    assert.equal(messages.filter((message) => message.partType === "compaction").length, 1);
    assert.equal(messages.at(-1)?.text, "Reasoning continued after compaction");
  }

  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  const states = await reconciler.reconcile([{ providerSessionId: "thread-live", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-live"), "working", "compaction does not end the writer-owned turn");
});

test("complete rollout history recovers old delegation prompt and terminal answer beyond the recent cap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-complete-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const at = "2026-08-23T01:00:00.000Z";
  const record = (value: Record<string, unknown>) => JSON.stringify({ timestamp: at, ...value });
  const lines = [
    record({ type: "response_item", payload: { type: "message", id: "bootstrap", role: "user", content: [
      { type: "input_text", text: "<recommended_plugins>private</recommended_plugins>" },
      { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>private</INSTRUCTIONS>" },
      { type: "input_text", text: "<environment_context>private</environment_context>" },
    ] } }),
    record({ type: "response_item", payload: { type: "message", id: "delegated", role: "user", content: [{ type: "input_text", text: "<codex_delegation><source_thread_id>secret</source_thread_id><input>Original delegated task</input></codex_delegation>" }] } }),
    ...Array.from({ length: 420 }, (_, index) => record({ type: "response_item", payload: { type: "reasoning", id: `r${index}`, summary: [{ type: "summary_text", text: `step ${index}` }] } })),
    record({ type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Complete final answer" }] } }),
  ];
  await writeFile(rollout, `${lines.join("\n")}\n`, "utf8");
  const messages = await readAllRolloutMessages(rollout);
  assert.equal(messages[0]?.messageId, "delegated");
  assert.equal(messages[0]?.text, "Original delegated task");
  assert.deepEqual(messages[0]?.origin, { kind: "delegation", sender: "codex" });
  assert.equal(messages.at(-1)?.text, "Complete final answer");
  assert.equal(messages.at(-1)?.phase, "final_answer");
  assert.doesNotMatch(JSON.stringify(messages), /AGENTS\.md|source_thread_id|codex_delegation/u);
});

test("Codex rollout history presents realtime user transcripts once and hides backend handoff markup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-realtime-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const record = (timestamp: string, value: Record<string, unknown>) => JSON.stringify({ timestamp, ...value });
  const realtimeEnvelope = (input: string) => `<realtime_delegation>\n  <input>${input}</input>\n  <transcript_delta>user: private rolling context</transcript_delta>\n</realtime_delegation>`;
  await writeFile(rollout, [
    record("2026-08-30T16:05:37.079Z", { type: "realtime_item", payload: { id: "voice-start", realtime_session_id: "voice-1", type: "realtime_session_started" } }),
    record("2026-08-30T16:05:40.170Z", { type: "realtime_item", payload: { id: "voice-user-1", realtime_session_id: "voice-1", type: "transcript_segment", role: "user", text: " Yo" } }),
    record("2026-08-30T16:05:40.300Z", { type: "response_item", payload: { type: "message", id: "backend-user-1", role: "user", content: [{ type: "input_text", text: realtimeEnvelope("Yo") }] } }),
    record("2026-08-30T16:05:41.000Z", { type: "response_item", payload: { type: "message", id: "backend-answer", role: "assistant", content: [{ type: "output_text", text: "[COMPLETE] Hey!" }] } }),
    record("2026-08-30T16:05:42.000Z", { type: "realtime_item", payload: { id: "voice-user-2", realtime_session_id: "voice-1", type: "transcript_segment", role: "user", text: " What folder are you in?" } }),
    record("2026-08-30T16:05:42.100Z", { type: "response_item", payload: { type: "message", id: "backend-user-2", role: "user", content: [{ type: "input_text", text: realtimeEnvelope("What folder are you in?") }] } }),
    record("2026-08-30T16:05:43.000Z", { type: "response_item", payload: { type: "message", id: "voice-tail", role: "user", content: [{ type: "input_text", text: "<realtime_delegation><source>transcript_tail_flush</source><input>The user just ended their realtime session.</input><transcript_delta>private tail</transcript_delta></realtime_delegation>" }] } }),
  ].join("\n"), "utf8");

  for (const messages of [await readRecentRolloutMessages(rollout), await readAllRolloutMessages(rollout)]) {
    assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.text), ["Yo", "What folder are you in?"]);
    assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.messageId), ["voice-user-1", "voice-user-2"]);
    assert.equal(messages.filter((message) => message.text === "Yo").length, 1, "the backend delegation echo must not duplicate the spoken turn");
    assert.doesNotMatch(JSON.stringify(messages), /realtime_delegation|transcript_delta|private rolling context|private tail|user just ended/iu);
  }
});

test("terminal rollout records recover a missing final, avoid duplicates, and expose interruption without metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-terminal-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const fallbackRollout = join(directory, "fallback.jsonl");
  const duplicateRollout = join(directory, "duplicate.jsonl");
  const abortedRollout = join(directory, "aborted.jsonl");
  const record = (timestamp: string, value: Record<string, unknown>) => JSON.stringify({ timestamp, ...value });

  await writeFile(fallbackRollout, [
    record("2026-08-24T10:00:00.000Z", { type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "Finish the task" }] } }),
    record("2026-08-24T10:00:01.000Z", { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Recovered final answer" } }),
  ].join("\n"), "utf8");
  const fallback = await readAllRolloutMessages(fallbackRollout);
  assert.equal(fallback.at(-1)?.text, "Recovered final answer");
  assert.equal(fallback.at(-1)?.phase, "final_answer");
  assert.equal(fallback.at(-1)?.terminalFallback, true);

  await writeFile(duplicateRollout, [
    record("2026-08-24T10:01:00.000Z", { type: "response_item", payload: { type: "message", id: "u2", role: "user", content: [{ type: "input_text", text: "Finish again" }] } }),
    record("2026-08-24T10:01:01.000Z", { type: "response_item", payload: { type: "message", id: "a2", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "One final answer" }] } }),
    record("2026-08-24T10:01:02.000Z", { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2", last_agent_message: "One final answer" } }),
  ].join("\n"), "utf8");
  const duplicate = await readAllRolloutMessages(duplicateRollout);
  assert.equal(duplicate.filter((message) => message.phase === "final_answer").length, 1);

  await writeFile(abortedRollout, [
    record("2026-08-24T10:02:00.000Z", { type: "response_item", payload: { type: "message", id: "abort-meta", role: "user", content: [{ type: "input_text", text: "<turn_aborted>provider metadata</turn_aborted>" }] } }),
    record("2026-08-24T10:02:01.000Z", { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-3" } }),
  ].join("\n"), "utf8");
  const aborted = await readAllRolloutMessages(abortedRollout);
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0]?.text, "Task interrupted");
  assert.deepEqual(aborted[0]?.parts, [{ type: "error", message: "Task interrupted", code: "TURN_ABORTED" }]);
  assert.equal(aborted[0]?.terminalError, true);
  assert.doesNotMatch(JSON.stringify(aborted), /turn_aborted|provider metadata/u);
});

test("rollout history joins Codex's two user-record representations without collapsing repeated prompts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-user-record-correlation-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const response = (timestamp: string, ordinal: number, id: string, turnId: string, text: string) => JSON.stringify({
    timestamp,
    ordinal,
    type: "response_item",
    payload: {
      type: "message",
      id,
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
  const completed = (timestamp: string, ordinal: number, id: string, turnId: string, text: string) => JSON.stringify({
    timestamp,
    ordinal,
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: turnId,
      item: { type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] },
    },
  });
  await writeFile(rollout, [
    response("2026-08-25T07:39:06.171Z", 17, "msg_01a037db-ca3b-7d13-b76c-c4f073d15934", "01a037db-c6be-73d0-a2b9-84c15bf27495", "Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2\n"),
    completed("2026-08-25T07:39:06.191Z", 18, "01a037db-ca4f-7481-bcbc-5c677c2e951b", "01a037db-c6be-73d0-a2b9-84c15bf27495", "Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2\n"),
    response("2026-08-25T07:39:07.171Z", 19, "msg-copy-2", "01a037db-c6be-73d0-a2b9-84c15bf27495", "Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2\n"),
    completed("2026-08-25T07:39:07.191Z", 20, "canonical-2", "01a037db-c6be-73d0-a2b9-84c15bf27495", "Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2\n"),
  ].join("\n"), "utf8");

  const complete = await readAllRolloutMessages(rollout);
  const recent = await readRecentRolloutMessages(rollout);

  assert.deepEqual(complete.map((message) => message.messageId), ["01a037db-ca4f-7481-bcbc-5c677c2e951b", "canonical-2"]);
  assert.deepEqual(recent.map((message) => message.messageId), ["01a037db-ca4f-7481-bcbc-5c677c2e951b", "canonical-2"]);
  assert.deepEqual(complete.map((message) => message.turnId), ["01a037db-c6be-73d0-a2b9-84c15bf27495", "01a037db-c6be-73d0-a2b9-84c15bf27495"]);
  assert.deepEqual(complete.map((message) => message.canonicalUserMessage), [true, true]);
  assert.equal(complete.length, 2, "two genuinely repeated user actions must remain two messages");
});

test("modern user_message acknowledgements canonicalize scheduled rollout history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-modern-user-correlation-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const prompt = "QA marker scheduled-fixture-codex. This deliberately long scheduled instruction verifies that the complete optimistic user message survives provider materialization. Reply exactly SCHEDULED_OK_CODEX.";
  await writeFile(rollout, [
    JSON.stringify({
      timestamp: "2026-08-29T15:43:02.725Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_scheduled_fixture",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-scheduled-fixture" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-29T15:43:02.726Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "schedule_fixture_request",
        message: prompt,
        images: [],
        local_images: [],
        audio: [],
        local_audio: [],
        text_elements: [],
      },
    }),
  ].join("\n"), "utf8");

  const expected = [{
    messageId: "schedule_fixture_request",
    turnId: "turn-scheduled-fixture",
    canonicalUserMessage: true,
    role: "user" as const,
    text: prompt,
    partType: "text" as const,
    parts: [{ type: "text" as const, text: prompt }],
    createdAt: "2026-08-29T15:43:02.725Z",
  }];
  assert.deepEqual(await readAllRolloutMessages(rollout), expected);
  assert.deepEqual(await readRecentRolloutMessages(rollout), expected);
});

test("rollout history does not join user records across turns or a stale event gap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-user-record-mismatch-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, [
    JSON.stringify({
      timestamp: "2026-08-25T01:17:20.000Z",
      ordinal: 20,
      type: "response_item",
      payload: {
        type: "message",
        id: "original-id",
        role: "user",
        content: [{ type: "input_text", text: "Keep this distinct" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-a" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-25T01:17:25.000Z",
      ordinal: 21,
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-a",
        item: { type: "UserMessage", id: "stale-id", content: [{ type: "text", text: "Keep this distinct" }] },
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-25T01:17:20.020Z",
      ordinal: 22,
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-b",
        item: { type: "UserMessage", id: "other-turn-id", content: [{ type: "text", text: "Keep this distinct" }] },
      },
    }),
  ].join("\n"), "utf8");

  assert.equal((await readAllRolloutMessages(rollout))[0]?.messageId, "original-id");
  assert.equal((await readRecentRolloutMessages(rollout))[0]?.messageId, "original-id");
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
        { type: "input_text", text: "\n<in-app-browser-context source=\"ambient-ui-state\">\n# In app browser:\n- Current URL: https://example.test/private\n</in-app-browser-context>\n\n# Files mentioned by the user:\n\n## screenshot.png: C:/Users/person/AppData/Local/Temp/screenshot.png\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nPlease match this layout.\n" },
        { type: "input_text", text: '<image name=[Image #1] path="C:\\Users\\person\\AppData\\Local\\Temp\\screenshot.png">' },
        { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "original" },
        { type: "input_text", text: "</image>" },
      ],
    },
  })}\n`, "utf8");

  const expected = [{
    messageId: "user-with-image",
    role: "user",
    text: "Please match this layout.",
    partType: "text",
    parts: [
      { type: "text", text: "Please match this layout." },
      { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "screenshot.png" },
    ],
    createdAt: at,
  }];
  assert.deepEqual(await readRecentRolloutMessages(rollout), expected);
  assert.deepEqual(await readAllRolloutMessages(rollout), expected);
  assert.doesNotMatch(JSON.stringify(expected), /ambient-ui-state|My request|Files mentioned|C:\\\\Users/u);
});

test("rollout history hides response-annotation control directives from assistant text", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-annotation-directive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, messageLine("assistant-final", "assistant", ':codex-annotation{index="1"} Visible answer', "final_answer"), "utf8");

  const messages = await readAllRolloutMessages(rollout);

  assert.equal(messages[0]?.text, "Visible answer");
  assert.equal(messages[0]?.phase, "final_answer");
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

test("runtime metadata polling consumes bounded appended bytes instead of rescanning history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-incremental-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const changes: Array<[string, CodexTurnMetadata]> = [];
  await writeFile(rollout, turnContext("gpt-initial", "medium"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
    onTurnMetadataChanged: (threadId, metadata) => { changes.push([threadId, metadata]); },
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "working" }]);
  await reconciler.watchSession("thread-1");

  await appendFile(rollout, `${JSON.stringify({ type: "response_item", payload: { output: "x".repeat(1_100_000) } })}\n${turnContext("gpt-appended", "high")}`, "utf8");
  await reconciler.pollNow();
  assert.deepEqual(changes, [], "one poll must not jump past the bounded append window by rescanning from the end");
  await reconciler.pollNow();
  assert.deepEqual(changes, [["thread-1", { modelId: "gpt-appended", reasoningEffort: "high" }]]);
});

test("recent preview history is read once and advanced from appended rollout bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-preview-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, messageLine("old", "assistant", "historical preview"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "working" }]);
  await reconciler.watchSession("thread-1");

  assert.equal((await reconciler.recentMessages("thread-1")).at(-1)?.text, "historical preview");
  await appendFile(rollout, messageLine("new", "assistant", "not visible before polling"), "utf8");
  assert.equal((await reconciler.recentMessages("thread-1")).at(-1)?.text, "historical preview");
  await reconciler.pollNow();
  assert.equal((await reconciler.recentMessages("thread-1")).at(-1)?.text, "not visible before polling");
});

test("complete history reuses its parsed snapshot and advances only from appended rollout records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-complete-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const user = messageLine("user-1", "user", "keep the old object");
  const call = `${JSON.stringify({
    timestamp: "2026-08-25T10:00:01.000Z",
    type: "response_item",
    payload: { type: "function_call", call_id: "call-1", name: "exec", arguments: JSON.stringify({ cmd: "rg history" }) },
  })}\n`;
  await writeFile(rollout, `${user}${call}`, "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);

  const first = await reconciler.allMessages("thread-1");
  const unchanged = await reconciler.allMessages("thread-1");
  assert.equal(unchanged, first, "an unchanged older-page load must reuse the parsed snapshot");

  await appendFile(rollout, [
    `${JSON.stringify({
      timestamp: "2026-08-25T10:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "one match" },
    })}\n`,
    `${JSON.stringify({
      timestamp: "2026-08-25T10:00:03.000Z",
      type: "response_item",
      payload: { type: "message", id: "final-1", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] },
    })}\n`,
    `${JSON.stringify({
      timestamp: "2026-08-25T10:00:04.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Done" },
    })}\n`,
  ].join(""), "utf8");

  const appended = await reconciler.allMessages("thread-1");
  assert.notEqual(appended, first);
  assert.equal(appended[0], first[0], "appending must retain parsed prefix objects instead of reparsing the file");
  assert.equal(appended.find((message) => message.messageId === "call-1")?.text, "one match");
  assert.equal(appended.filter((message) => message.phase === "final_answer").length, 1);
  assert.equal((await reconciler.allMessages("thread-1")), appended);

  await appendFile(rollout, [
    messageLine("user-2", "user", "stop this turn"),
    `${JSON.stringify({
      timestamp: "2026-08-25T10:00:06.000Z",
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn-2" },
    })}\n`,
  ].join(""), "utf8");
  const interrupted = await reconciler.allMessages("thread-1");
  assert.equal(interrupted.at(-1)?.text, "Task interrupted");
  assert.equal(interrupted.at(-1)?.terminalError, true);
});

test("complete history invalidates its cache for same-path rewrites, truncation, and rollout rotation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-complete-invalidation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const rotated = join(directory, "rotated.jsonl");
  const original = messageLine("old-id", "assistant", "old text");
  const sameSizeReplacement = messageLine("new-id", "assistant", "new text");
  assert.equal(Buffer.byteLength(sameSizeReplacement), Buffer.byteLength(original));
  await writeFile(rollout, original, "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rollout, nativeState: "idle" }]);
  const first = await reconciler.allMessages("thread-1");

  await writeFile(rollout, sameSizeReplacement, "utf8");
  const replaced = await reconciler.allMessages("thread-1");
  assert.notEqual(replaced, first);
  assert.deepEqual(replaced.map((message) => message.messageId), ["new-id"]);

  await writeFile(rollout, messageLine("tiny", "assistant", "x"), "utf8");
  assert.deepEqual((await reconciler.allMessages("thread-1")).map((message) => message.messageId), ["tiny"]);

  await writeFile(rotated, messageLine("rotated", "assistant", "other file"), "utf8");
  await reconciler.reconcile([{ providerSessionId: "thread-1", path: rotated, nativeState: "idle" }]);
  assert.deepEqual((await reconciler.allMessages("thread-1")).map((message) => message.messageId), ["rotated"]);
});

test("a watched native thread keeps observing exact metadata without replaying messages", async (t) => {
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
  await reconciler.watchSession("thread-1");
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

test("idle catalogue refresh skips rollout reads and only the watched task is baselined and polled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-watched-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first.jsonl");
  const second = join(directory, "second.jsonl");
  const changes: Array<[string, CodexTurnMetadata]> = [];
  await writeFile(first, turnContext("gpt-first", "medium"), "utf8");
  await writeFile(second, turnContext("gpt-second", "medium"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
    onTurnMetadataChanged: (threadId, metadata) => { changes.push([threadId, metadata]); },
  });
  t.after(() => reconciler.dispose());

  await reconciler.reconcile([
    { providerSessionId: "thread-1", path: first, nativeState: "idle" },
    { providerSessionId: "thread-2", path: second, nativeState: "idle" },
  ]);
  await reconciler.watchSession("thread-1");
  assert.deepEqual(reconciler.turnMetadata("thread-1"), { modelId: "gpt-first", reasoningEffort: "medium" });
  assert.equal(reconciler.turnMetadata("thread-2"), undefined, "an unopened idle task does not delay the catalogue with rollout metadata reads");
  await appendFile(first, turnContext("gpt-first", "high"), "utf8");
  await appendFile(second, turnContext("gpt-second", "high"), "utf8");
  await reconciler.pollNow();

  assert.deepEqual(changes, [["thread-1", { modelId: "gpt-first", reasoningEffort: "high" }]]);
  assert.equal(reconciler.turnMetadata("thread-2"), undefined);
  reconciler.unwatchSession("thread-1");
  await appendFile(first, turnContext("gpt-first", "low"), "utf8");
  await reconciler.pollNow();
  assert.equal(changes.length, 1, "an idle task stops sub-second metadata polling when its view closes");
});

test("cold notLoaded catalogue rows stay cheap until the task is watched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-cold-catalogue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "cold.jsonl");
  await writeFile(rollout, turnContext("gpt-cold", "high"), "utf8");
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());

  const states = await reconciler.reconcile([{
    providerSessionId: "thread-cold",
    path: rollout,
    nativeState: "unknown",
    observeUnknown: false,
  }]);
  assert.equal(states.get("thread-cold"), "unknown");
  assert.equal(reconciler.turnMetadata("thread-cold"), undefined, "a cold rail row must not scan its rollout");

  await reconciler.watchSession("thread-cold");
  assert.deepEqual(reconciler.turnMetadata("thread-cold"), { modelId: "gpt-cold", reasoningEffort: "high" }, "opening the task restores full observation");
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

test("a retired unterminated rollout cannot be revived by the same stale writer lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-retired-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const changes: Array<[string, SessionState]> = [];
  let lockHeld = true;
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 60_000,
    isLockHeld: async () => lockHeld,
    onStateChanged: (threadId, state) => { changes.push([threadId, state]); },
  });
  t.after(() => reconciler.dispose());

  await writeFile(rollout, line("task_started"), "utf8");
  let states = await reconciler.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "working");
  assert.equal(reconciler.hasActiveTurn("thread-retired"), true);

  lockHeld = false;
  await reconciler.pollNow("thread-retired");
  assert.deepEqual(changes, [["thread-retired", "idle"]]);
  assert.equal(reconciler.hasActiveTurn("thread-retired"), false);

  // A catalogue-owned idle pass may stop tracking the rollout. The retirement
  // evidence must survive that pass rather than treating a returning stale lock
  // as a brand-new turn.
  states = await reconciler.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "idle" }]);
  assert.equal(states.get("thread-retired"), "idle");
  lockHeld = true;
  states = await reconciler.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "idle");
  assert.equal(reconciler.hasActiveTurn("thread-retired"), false);
  assert.deepEqual(changes, [["thread-retired", "idle"]], "the same lock and rollout bytes must not publish another working transition");

  await appendFile(rollout, line("task_started"), "utf8");
  states = await reconciler.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "working", "new rollout bytes may prove that a new turn actually started");
  assert.equal(reconciler.hasActiveTurn("thread-retired"), true);
});

test("retired rollout evidence survives a reconciler restart until the rollout changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-retired-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const retirementStatePath = join(directory, "retirements.json");
  let lockHeld = true;
  await writeFile(rollout, line("task_started"), "utf8");

  const first = new CodexActivityReconciler({
    codexHome: directory,
    retirementStatePath,
    pollIntervalMs: 60_000,
    isLockHeld: async () => lockHeld,
    onStateChanged: () => undefined,
  });
  let states = await first.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "working");
  lockHeld = false;
  await first.pollNow("thread-retired");
  await first.dispose();

  lockHeld = true;
  const restarted = new CodexActivityReconciler({
    codexHome: directory,
    retirementStatePath,
    pollIntervalMs: 60_000,
    isLockHeld: async () => lockHeld,
    onStateChanged: () => undefined,
  });
  t.after(() => restarted.dispose());
  states = await restarted.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "idle", "an orphaned lock file must stay retired after Tethoq restarts");

  await appendFile(rollout, line("task_started"), "utf8");
  states = await restarted.reconcile([{ providerSessionId: "thread-retired", path: rollout, nativeState: "unknown" }]);
  assert.equal(states.get("thread-retired"), "working", "new rollout bytes prove a genuinely new turn");
});

test("a rotated rollout supersedes durable retirement and a malformed store fails open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-retired-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstRollout = join(directory, "first.jsonl");
  const secondRollout = join(directory, "second.jsonl");
  const retirementStatePath = join(directory, "retirements.json");
  await writeFile(firstRollout, line("task_started"), "utf8");
  let lockHeld = false;
  const first = new CodexActivityReconciler({
    codexHome: directory,
    retirementStatePath,
    isLockHeld: async () => lockHeld,
    onStateChanged: () => undefined,
  });
  assert.equal((await first.reconcile([{ providerSessionId: "thread-rotated", path: firstRollout, nativeState: "unknown" }])).get("thread-rotated"), "idle");
  await first.dispose();

  await writeFile(secondRollout, line("task_started"), "utf8");
  lockHeld = true;
  const rotated = new CodexActivityReconciler({
    codexHome: directory,
    retirementStatePath,
    isLockHeld: async () => lockHeld,
    onStateChanged: () => undefined,
  });
  assert.equal((await rotated.reconcile([{ providerSessionId: "thread-rotated", path: secondRollout, nativeState: "unknown" }])).get("thread-rotated"), "working");
  await rotated.dispose();

  await writeFile(retirementStatePath, "{ incomplete", "utf8");
  const recovered = new CodexActivityReconciler({
    codexHome: directory,
    retirementStatePath,
    isLockHeld: async () => true,
    onStateChanged: () => undefined,
  });
  t.after(() => recovered.dispose());
  assert.equal((await recovered.reconcile([{ providerSessionId: "thread-recovered", path: secondRollout, nativeState: "unknown" }])).get("thread-recovered"), "working");
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

test("active thread discovery returns only held real Codex UUID lock files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  await mkdir(lockDirectory, { recursive: true });
  const threadIds = Array.from({ length: 21 }, (_, index) =>
    `019ffeab-3a74-7140-87f2-${index.toString(16).padStart(12, "0")}`);
  await Promise.all([
    ...threadIds.map(async (threadId) => await writeFile(join(lockDirectory, `${threadId}.lock`), "")),
    writeFile(join(lockDirectory, ".coordination.lock"), ""),
    writeFile(join(lockDirectory, "not-a-session.lock"), ""),
  ]);
  const orphanedThreadId = threadIds.at(-1)!;
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    isLockHeld: async (path) => !path.endsWith(`${orphanedThreadId}.lock`),
    onStateChanged: () => undefined,
  });
  t.after(() => reconciler.dispose());
  assert.deepEqual(new Set(await reconciler.activeThreadIds()), new Set(threadIds.filter((threadId) => threadId !== orphanedThreadId)));
});

test("active thread discovery notices a writer created after the catalogue baseline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-lock-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  await mkdir(lockDirectory, { recursive: true });
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const discoveries: string[] = [];
  let resolveDiscovery: ((value: string) => void) | undefined;
  const discovered = new Promise<string>((resolve) => { resolveDiscovery = resolve; });
  const reconciler = new CodexActivityReconciler({
    codexHome: directory,
    pollIntervalMs: 5,
    isLockHeld: async (path) => path.endsWith(`${threadId}.lock`),
    onStateChanged: () => undefined,
    onActiveThreadDiscovered: (providerSessionId) => {
      discoveries.push(providerSessionId);
      resolveDiscovery?.(providerSessionId);
    },
  });
  t.after(() => reconciler.dispose());

  assert.deepEqual(await reconciler.activeThreadIds(), [], "the initial empty listing establishes the discovery baseline");
  await writeFile(join(lockDirectory, "not-a-session.lock"), "");
  await writeFile(join(lockDirectory, `${threadId}.lock`), "");
  const observed = await Promise.race([
    discovered,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("writer discovery timed out")), 500)),
  ]);
  assert.equal(observed, threadId);
  assert.deepEqual(discoveries, [threadId]);
});

test("an unavailable lock directory preserves the last successful active snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-lock-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, `${threadId}.lock`), "");
  const reconciler = new CodexActivityReconciler({ codexHome: directory, isLockHeld: async () => true, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());

  assert.deepEqual(await reconciler.activeThreadIds(), [threadId]);
  await rm(lockDirectory, { recursive: true });
  assert.deepEqual(await reconciler.activeThreadIds(), [threadId], "a read failure is unknown, not an empty writer set");
});

test("writer-lock lookup is path-safe and ignores an orphaned lock file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-writer-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const lockPath = join(lockDirectory, `${threadId}.lock`);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(lockPath, "");
  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());

  assert.equal(await reconciler.hasWriterLock(threadId), false);
  assert.equal(await reconciler.hasWriterLock("..\\outside"), false);
  await rm(lockPath);
  assert.equal(await reconciler.hasWriterLock(threadId), false);
});

test("writer-lock lookup detects a lock that another Windows process actually holds", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-writer-held-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "thread-writer-locks");
  const threadId = "019ffeab-3a74-7140-87f2-cd348d5ee856";
  const lockPath = join(lockDirectory, `${threadId}.lock`);
  const releasePath = join(directory, "release.lock-holder");
  await mkdir(lockDirectory, { recursive: true });
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const holderScript = [
    "$path = [Environment]::GetEnvironmentVariable('TETHOQ_TEST_LOCK_PATH')",
    "$releasePath = [Environment]::GetEnvironmentVariable('TETHOQ_TEST_LOCK_RELEASE_PATH')",
    "$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "while (-not [System.IO.File]::Exists($releasePath)) { [Threading.Thread]::Sleep(50) }",
    "$stream.Dispose()",
  ].join("; ");
  const holder = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", holderScript], {
    env: {
      ...process.env,
      TETHOQ_TEST_LOCK_PATH: lockPath,
      TETHOQ_TEST_LOCK_RELEASE_PATH: releasePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer-lock holder did not start")), 3_000);
    holder.once("error", (error) => { clearTimeout(timer); reject(error); });
    holder.stdout.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      assert.match(chunk.toString("utf8"), /READY/u);
      resolve();
    });
  });
  const release = async (): Promise<void> => {
    if (holder.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    await writeFile(releasePath, "", "utf8");
    await exited;
  };
  t.after(release);
  await ready;

  const reconciler = new CodexActivityReconciler({ codexHome: directory, onStateChanged: () => undefined });
  t.after(() => reconciler.dispose());
  assert.deepEqual(await reconciler.activeThreadIds(), [threadId]);
  assert.equal(await reconciler.hasWriterLock(threadId), true);
  await release();
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(await reconciler.activeThreadIds(), []);
  assert.equal(await reconciler.hasWriterLock(threadId), false, "the file can remain while its owning handle is gone");
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

test("rollout observer holds a synthetic final until compaction proves the turn continues", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-codex-live-compaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const observed: CodexObservedMessage[] = [];
  const handoff = `## Handoff summary\n\n${"Continue the same live turn after context is compacted. ".repeat(4).trim()}`;
  const compacted = `Another language model started to solve this problem and produced a summary of its thinking process.\n\nYou also have access to the state of the tools.\n\n${handoff}`;
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

  await appendFile(rollout, [
    `${JSON.stringify({ timestamp: "2026-08-28T22:00:16.106Z", type: "response_item", payload: { type: "message", id: "user-live", role: "user", content: [{ type: "input_text", text: "Keep working" }] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.056Z", type: "response_item", payload: { type: "message", id: "internal-handoff", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `${handoff}\n\n<oai-mem-citation>private</oai-mem-citation>` }] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.138Z", type: "event_msg", payload: { type: "token_count", info: {} } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:02.154Z", type: "compacted", payload: { message: compacted, replacement_history: [] } })}\n`,
    `${JSON.stringify({ timestamp: "2026-08-28T22:01:10.814Z", type: "response_item", payload: { type: "message", id: "continued", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Still working after compaction" }] } })}\n`,
  ].join(""), "utf8");
  await reconciler.pollNow();

  assert.deepEqual(observed.map((message) => [message.messageId, message.partType, message.phase]), [
    ["user-live", "text", undefined],
    ["compaction-2026-08-28T22:01:02.154Z", "compaction", "commentary"],
    ["continued", "text", "commentary"],
  ]);
  assert.equal(observed.some((message) => message.phase === "final_answer"), false);
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
  assert.deepEqual(observed, [], "a persisted final waits for the task lifecycle record that proves it is terminal");
  await appendFile(rollout, line("task_complete"), "utf8");
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
