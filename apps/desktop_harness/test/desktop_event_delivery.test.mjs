import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual runtime methods with a deterministic event-loop queue;
// no Electron process, real provider or periodic heartbeat is needed.
const source = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("runtime.ts", source, ts.ScriptTarget.Latest, true);
const runtime = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "DesktopRuntime");
const methods = ["queueEventFlush", "pollEvents"].map(name => {
  const method = runtime.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === name);
  assert.ok(method, `Runtime method ${name} exists`);
  return method.getText(tree);
}).join("\n");
const maximumBatch = source.match(/const MAX_EVENT_BATCH = (\d+);/u)?.[1];
assert.ok(maximumBatch);
const code = ts.transpileModule(`
  const MAX_EVENT_BATCH = ${maximumBatch};
  class RuntimeDeliveryFixture {
    #bridge; #onEvents; #disposed = false; #eventFlushQueued = false; #latestSequence = 0;
    constructor(bridge, onEvents) { this.#bridge = bridge; this.#onEvents = onEvents; }
    notify() { this.queueEventFlush(); }
    dispose() { this.#disposed = true; }
    ${methods}
  }
  globalThis.RuntimeDeliveryFixture = RuntimeDeliveryFixture;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const callbacks = [], pending = [], batches = [];
  let sequence = 0;
  const context = vm.createContext({ setImmediate: callback => callbacks.push(callback) });
  vm.runInContext(code, context);
  const bridge = { eventReplaySince: cursor => ({ events: pending.filter(event => event.sequence > cursor), latestSequence: sequence, replayGap: false }) };
  const delivery = new context.RuntimeDeliveryFixture(bridge, batch => batches.push(batch));
  return {
    delivery, batches, callbacks,
    append(type) { pending.push({ sequence: ++sequence, type }); delivery.notify(); },
    tick() { assert.ok(callbacks.length, "a flush is scheduled"); callbacks.shift()(); },
  };
}

test("a burst drains bounded batches promptly through text, coordination and completion", () => {
  const run = fixture();
  for (let index = 0; index < 1000; index++) run.append("message.delta");
  run.append("message.remote_received"); run.append("agent.completed");
  assert.equal(run.callbacks.length, 1, "native event bursts coalesce into one scheduled flush");
  for (let index = 0; index < 6; index++) run.tick();
  assert.deepEqual(run.batches.map(batch => batch.events.length), [200, 200, 200, 200, 200, 2]);
  const delivered = run.batches.flatMap(batch => batch.events);
  assert.equal(delivered.length, 1002);
  assert.equal(delivered.at(-2).type, "message.remote_received");
  assert.equal(delivered.at(-1).type, "agent.completed");
  assert.deepEqual(delivered.map(event => event.sequence), Array.from({ length: 1002 }, (_, index) => index + 1));
  assert.equal(run.callbacks.length, 0, "the drain stops when caught up");
});

test("events appended between batches stay ordered and disposal cancels pending delivery", () => {
  const run = fixture();
  for (let index = 0; index < 210; index++) run.append("message.delta");
  run.tick(); run.append("agent.completed");
  assert.equal(run.callbacks.length, 1, "a new append shares the pending drain");
  run.tick();
  assert.equal(run.batches[1].events.length, 11);
  assert.equal(run.batches[1].events.at(-1).sequence, 211);
  run.append("message.delta"); run.delivery.dispose(); run.tick();
  assert.equal(run.batches.length, 2);
  assert.equal(run.callbacks.length, 0);
});
