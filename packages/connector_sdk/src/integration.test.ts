import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConnectorProcessClient } from "./client.js";
import { parseConnectorManifest } from "./manifest.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "connector_fixture.js");
const manifest = parseConnectorManifest({
  manifestVersion: 1,
  id: "test.fixture",
  name: "Test Fixture",
  version: "1.0.0",
  runtime: { transport: "stdio-jsonl", command: process.execPath, args: [fixture] },
  permissions: { filesystem: "none", network: false, spawnProcesses: false },
  capabilities: { listSessions: true, sessionHistory: true, createSession: true, sendMessage: true, messageQueue: true, streamingText: true, modelEnumeration: true },
  models: [{ id: "fixture-model", displayName: "Fixture Model", isDefault: true }],
});

const host = { id: "test-host", name: "Test Host", version: "1.0.0", platform: "windows" as const };

test("process client initializes, lists models, creates, streams, reads history, and shuts down", async () => {
  const events: string[] = [];
  const client = new ConnectorProcessClient({ manifest, host, env: {}, onEvent: ({ event }) => { events.push(String(event.payload.text)); } });
  try {
    const initialized = await client.start();
    assert.equal(initialized.connector.id, "test.fixture");
    const models = await client.request("provider.models.list", {});
    assert.deepEqual(models.map((model) => model.id), ["fixture-model"]);
    assert.equal((await client.request("session.queue.list", {})).length, 2);
    assert.deepEqual((await client.request("session.queue.list", { sessionId: "session_two" })).map((message) => message.id), ["queued_two"]);
    const session = await client.request("session.create", { workingDirectory: "C:\\work", title: "SDK round trip", modelId: "fixture-model" });
    const subscription = await client.request("events.subscribe", { sessionId: session.id });
    const sent = await client.request("session.message.send", { sessionId: session.id, requestId: "request_1", content: "hello" });
    assert.equal(sent.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["Fixture: hello"]);
    const history = await client.request("session.messages.list", { sessionId: session.id });
    assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
    assert.equal(history[1]?.parts[0]?.type, "text");
    await client.request("events.unsubscribe", subscription);
    assert.equal(client.initialized, true);
  } finally {
    await client.shutdown();
  }
  assert.notEqual(client.exitState, undefined);
});

test("process exit immediately rejects pending and future calls with stderr context", async () => {
  const client = new ConnectorProcessClient({
    manifest,
    host,
    env: { CONNECTOR_FIXTURE_MODE: "exit_on_models" },
    timeoutMs: 20_000,
  });
  await client.start();
  const startedAt = Date.now();
  await assert.rejects(client.request("provider.models.list", {}), /Connector test\.fixture exited.*fixture stopped intentionally/);
  assert.ok(Date.now() - startedAt < 5_000, "exit rejection should not wait for the request timeout");
  await assert.rejects(client.request("provider.detect", {}), /Connector test\.fixture exited/);
  for (let index = 0; client.exitState === undefined && index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(client.exitState?.code, 7);
  assert.match(client.stderr.at(-1) ?? "", /fixture stopped intentionally/);
  await client.shutdown();
  await client.shutdown();
});
