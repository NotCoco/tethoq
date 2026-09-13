import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextLoop } from "node:timers/promises";
import test, { after } from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(tmpdir(), `tethoq-event-delivery-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "events.mjs");
await mkdir(outputDirectory, { recursive: true });
after(() => rm(outputDirectory, { recursive: true, force: true }));
await build({
  stdin: { resolveDir: appRoot, contents: `
    export { DesktopEventDelivery } from "./src/main/event_delivery.ts";
    export { EventReplayBuffer } from "../../packages/protocol/src/event_buffer.ts";
  `, loader: "ts" },
  outfile: bundle, bundle: true, format: "esm", platform: "node", target: "node22",
});
const { DesktopEventDelivery, EventReplayBuffer } = await import(pathToFileURL(bundle).href);

test("a tool-output burst delivers its final answer and idle without waiting for a heartbeat", async (t) => {
  const buffer = new EventReplayBuffer("host-events");
  const batches = [];
  const delivery = new DesktopEventDelivery(sequence => buffer.replaySince(sequence), batch => batches.push(batch));
  t.after(() => delivery.dispose());
  const unsubscribe = buffer.subscribe(() => delivery.schedule());
  t.after(unsubscribe);
  for (let index = 0; index < 1_000; index += 1) buffer.append({ type: "command.output", payload: { text: String(index) } });
  buffer.append({ type: "message.completed", payload: { text: "Done" } });
  buffer.append({ type: "agent.completed" });
  assert.equal(batches.length, 0, "a burst should coalesce before delivering to Electron");
  for (let turn = 0; turn < 8; turn += 1) await nextLoop();
  const events = batches.flatMap(batch => batch.events);
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 1_002 }, (_, index) => index + 1));
  assert.equal(events.at(-1).type, "agent.completed");
  assert.ok(batches.every(batch => batch.events.length <= 200), "main-process work must yield between bounded IPC batches");
  for (const batch of batches) assert.equal(batch.latestSequence, batch.events.at(-1).sequence, "a batch must not skip buffered events in its cursor");
  delivery.flush();
  assert.equal(batches.flatMap(batch => batch.events).length, 1_002, "a later heartbeat must not replay the burst");
});

test("reconnect gaps, newly appended events, and shutdown preserve delivery ordering", async () => {
  const buffer = new EventReplayBuffer("host-reconnect", 401);
  for (let index = 0; index < 800; index += 1) buffer.append({ type: "message.delta" });
  const batches = [];
  const delivery = new DesktopEventDelivery(sequence => buffer.replaySince(sequence), batch => {
    batches.push(batch);
    if (batches.length === 1) buffer.append({ type: "agent.completed" });
  });
  const unsubscribe = buffer.subscribe(() => delivery.schedule());
  try {
    delivery.schedule();
    for (let turn = 0; turn < 5; turn += 1) await nextLoop();
    assert.deepEqual(batches.flatMap(batch => batch.events).map(event => event.sequence), Array.from({ length: 402 }, (_, index) => index + 400));
    assert.deepEqual(batches.map(batch => batch.replayGap), [true, false, false]);
    buffer.append({ type: "message.delta" });
    delivery.dispose();
    await nextLoop();
    assert.equal(batches.at(-1).latestSequence, 801, "shutdown must cancel pending IPC delivery");
  } finally { unsubscribe(); delivery.dispose(); }
});
