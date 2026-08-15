import assert from "node:assert/strict";
import test from "node:test";
import { RelayServer } from "./relay.js";

function testToken(label: string): string {
  return `${label}-${"x".repeat(40)}`;
}

class JsonInbox {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];

  public constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = text; }
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(value);
      else this.#values.push(value);
    });
  }

  public async next(timeoutMs = 2_000): Promise<unknown> {
    const existing = this.#values.shift();
    if (existing !== undefined) return existing;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for relay message")), timeoutMs);
      this.#waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
}

async function connect(url: string): Promise<{ readonly socket: WebSocket; readonly inbox: JsonInbox }> {
  const socket = new WebSocket(url);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to relay")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay connection failed")); }, { once: true });
  });
  return { socket, inbox };
}

test("relay routes opaque payloads between one outbound host and its paired device", async (context) => {
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  context.after(async () => { await relay.close(); });
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const token = testToken("relay");

  const host = await connect(url);
  const device = await connect(url);
  context.after(() => { host.socket.close(); device.socket.close(); });

  host.socket.send(JSON.stringify({ type: "relay.attach", role: "host", hostId: "host_1", token }));
  assert.deepEqual(await host.inbox.next(), { type: "relay.attached", role: "host", hostId: "host_1", devices: 0 });
  device.socket.send(JSON.stringify({ type: "relay.attach", role: "device", hostId: "host_1", token, deviceId: "device_1" }));
  assert.deepEqual(await device.inbox.next(), { type: "relay.attached", role: "device", hostId: "host_1", deviceId: "device_1" });

  device.socket.send("opaque-device-request");
  assert.deepEqual(await host.inbox.next(), { type: "relay.forward", deviceId: "device_1", payload: "opaque-device-request" });
  host.socket.send(JSON.stringify({ type: "relay.forward", deviceId: "device_1", payload: "opaque-host-response" }));
  assert.equal(await device.inbox.next(), "opaque-host-response");
  assert.equal(relay.roomCount(), 1);
  assert.equal(relay.deviceCount("host_1"), 1);
});

test("relay rejects a device that presents the wrong channel token", async (context) => {
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  context.after(async () => { await relay.close(); });
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const host = await connect(url);
  context.after(() => host.socket.close());
  host.socket.send(JSON.stringify({ type: "relay.attach", role: "host", hostId: "host_1", token: testToken("correct") }));
  await host.inbox.next();

  const device = await connect(url);
  context.after(() => device.socket.close());
  device.socket.send(JSON.stringify({ type: "relay.attach", role: "device", hostId: "host_1", token: testToken("incorrect"), deviceId: "device_1" }));
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    device.socket.addEventListener("close", () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
  assert.equal(closed, true);
});
