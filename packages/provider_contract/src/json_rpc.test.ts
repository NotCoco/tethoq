import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcPeer, type JsonRpcTransport } from "./json_rpc.js";

class FakeJsonRpcTransport implements JsonRpcTransport {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();

  public async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async close(): Promise<void> {}

  public push(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("rejected notification handlers reach the peer error sink without an unhandled rejection", async () => {
  const transport = new FakeJsonRpcTransport();
  const handled: Error[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const peer = new JsonRpcPeer(transport, { onError: (error) => { handled.push(error); } });
  const failure = new Error("notification failed");
  peer.onNotification(async () => { throw failure; });

  try {
    transport.push({ jsonrpc: "2.0", method: "status.changed", params: {} });
    await flushAsyncHandlers();
    assert.deepEqual(handled, [failure]);
    assert.equal(peer.lastAsyncError, failure);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await peer.close();
  }
});

test("rejected request handlers return a JSON-RPC error without an unhandled rejection", async () => {
  const transport = new FakeJsonRpcTransport();
  const handled: Error[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const peer = new JsonRpcPeer(transport, { onError: (error) => { handled.push(error); } });
  peer.onRequest(async () => { throw new Error("request failed"); });

  try {
    transport.push({ jsonrpc: "2.0", id: "incoming-1", method: "do.work", params: {} });
    await flushAsyncHandlers();
    assert.deepEqual(transport.sent, [{
      jsonrpc: "2.0",
      id: "incoming-1",
      error: { code: -32000, message: "request failed" },
    }]);
    assert.deepEqual(handled, []);
    assert.equal(peer.lastAsyncError, null);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await peer.close();
  }
});
