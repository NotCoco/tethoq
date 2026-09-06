import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcPeer, type JsonRpcTransport } from "./json_rpc.js";

class FakeJsonRpcTransport implements JsonRpcTransport {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  public sendError: Error | null = null;

  public async send(message: unknown): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async close(): Promise<void> {}

  public push(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }

  public pushClose(error: Error): void {
    for (const listener of this.#closeListeners) listener(error);
  }
}

test("a detached request separates transport acceptance from the eventual response", async () => {
  const transport = new FakeJsonRpcTransport();
  const peer = new JsonRpcPeer(transport);
  try {
    const started = peer.startRequest<{ ok: boolean }>("task.start", { prompt: "later" });
    await started.sent;
    const request = transport.sent[0] as Record<string, unknown>;
    assert.equal(request.method, "task.start");
    transport.push({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
    assert.deepEqual(await started.result, { ok: true });
  } finally {
    await peer.close();
  }
});

test("a detached request rejects both handles when the transport cannot send", async () => {
  const transport = new FakeJsonRpcTransport();
  const failure = new Error("transport write failed");
  transport.sendError = failure;
  const peer = new JsonRpcPeer(transport);
  try {
    const started = peer.startRequest("task.start");
    await assert.rejects(started.result, /transport write failed/u);
    await assert.rejects(started.sent, /transport write failed/u);
  } finally {
    await peer.close();
  }
});

test("a detached request can opt out of the peer timeout for a long remote turn", async () => {
  const transport = new FakeJsonRpcTransport();
  const peer = new JsonRpcPeer(transport, { timeoutMs: 5 });
  try {
    const started = peer.startRequest<{ ok: boolean }>("task.long", {}, { timeoutMs: null });
    await started.sent;
    let settled = false;
    void started.result.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    const request = transport.sent[0] as Record<string, unknown>;
    transport.push({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
    assert.deepEqual(await started.result, { ok: true });
  } finally {
    await peer.close();
  }
});

test("transport termination rejects pending work immediately and marks the peer closed", async () => {
  const transport = new FakeJsonRpcTransport();
  const closed: Error[] = [];
  const peer = new JsonRpcPeer(transport, { timeoutMs: 60_000, onTransportClosed: (error) => { closed.push(error); } });
  const started = peer.startRequest("task.long");
  void started.result.catch(() => undefined);
  await started.sent;
  const failure = new Error("provider process exited");

  transport.pushClose(failure);

  await assert.rejects(started.result, failure);
  assert.deepEqual(closed, [failure]);
  assert.throws(() => peer.startRequest("task.again"), /closed/iu);
});

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

test("notifications stay ordered while a nested request response remains concurrent", async () => {
  const transport = new FakeJsonRpcTransport();
  const peer = new JsonRpcPeer(transport);
  const order: string[] = [];
  peer.onNotification(async (method) => {
    order.push(`${method}:start`);
    if (method === "first") {
      const response = await peer.request<{ ok: boolean }>("nested.request");
      assert.deepEqual(response, { ok: true });
    }
    order.push(`${method}:end`);
  });

  try {
    transport.push({ jsonrpc: "2.0", method: "first", params: {} });
    transport.push({ jsonrpc: "2.0", method: "second", params: {} });
    await flushAsyncHandlers();
    assert.deepEqual(order, ["first:start"], "the later notification must wait for the first handler");
    const nested = transport.sent.find((message) =>
      typeof message === "object" && message !== null && (message as Record<string, unknown>).method === "nested.request"
    ) as Record<string, unknown> | undefined;
    assert.ok(nested !== undefined);
    transport.push({ jsonrpc: "2.0", id: nested.id, result: { ok: true } });
    await flushAsyncHandlers();
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    await peer.close();
  }
});

test("a rejected notification does not block the notifications behind it", async () => {
  const transport = new FakeJsonRpcTransport();
  const handled: Error[] = [];
  const order: string[] = [];
  const peer = new JsonRpcPeer(transport, { onError: (error) => { handled.push(error); } });
  peer.onNotification(async (method) => {
    order.push(method);
    if (method === "first") throw new Error("first failed");
  });

  try {
    transport.push({ jsonrpc: "2.0", method: "first", params: {} });
    transport.push({ jsonrpc: "2.0", method: "second", params: {} });
    await flushAsyncHandlers();
    await flushAsyncHandlers();
    assert.deepEqual(order, ["first", "second"]);
    assert.deepEqual(handled.map((error) => error.message), ["first failed"]);
  } finally {
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
