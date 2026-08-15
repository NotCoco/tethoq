import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonLineStreamTransport, JsonRpcPeer } from "./jsonl_rpc.js";
import { ConnectorRemoteError } from "./errors.js";

function pair(): { left: JsonRpcPeer; right: JsonRpcPeer } {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  return {
    left: new JsonRpcPeer(new JsonLineStreamTransport({ input: rightToLeft, output: leftToRight })),
    right: new JsonRpcPeer(new JsonLineStreamTransport({ input: leftToRight, output: rightToLeft })),
  };
}

test("JSONL peer handles bidirectional requests and notifications", async () => {
  const { left, right } = pair();
  let notification = "";
  right.onRequest((method, params) => ({ method, params }));
  right.onNotification((_method, params) => { notification = String(params); });
  assert.deepEqual(await left.request("echo", { value: 7 }), { method: "echo", params: { value: 7 } });
  await left.notify("note", "received");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notification, "received");
  await Promise.all([left.close(), right.close()]);
});

test("JSONL peer returns structured remote errors", async () => {
  const { left, right } = pair();
  right.onRequest(() => { throw new Error("boom"); });
  await assert.rejects(left.request("explode"), (error) => error instanceof ConnectorRemoteError && error.code === -32603 && error.message === "boom");
  await Promise.all([left.close(), right.close()]);
});

test("JSONL stream rejects malformed protocol without executing a handler", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let called = false;
  const errors: Error[] = [];
  const transport = new JsonLineStreamTransport({ input, output });
  transport.onMessage(() => { called = true; });
  transport.onError((error) => errors.push(error));
  input.write("not-json\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
  assert.match(errors[0]?.message ?? "", /JSON/);
  await transport.close();
});
