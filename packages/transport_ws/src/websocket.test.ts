import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocketConnection } from "./websocket.js";

class TextInbox {
  readonly #messages: string[] = [];
  readonly #waiters: Array<(message: string) => void> = [];

  public constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = String(event.data);
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(message);
      else this.#messages.push(message);
    });
  }

  public async next(timeoutMs = 2_000): Promise<string> {
    const existing = this.#messages.shift();
    if (existing !== undefined) return existing;
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs);
      this.#waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

async function open(url: string): Promise<{ readonly socket: WebSocket; readonly inbox: TextInbox }> {
  const socket = new WebSocket(url);
  const inbox = new TextInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening WebSocket")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket open failed")); }, { once: true });
  });
  return { socket, inbox };
}

test("dependency-free WebSocket server performs RFC 6455 text round trips and pong tracking", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/socket" });
  let accepted: WebSocketConnection | undefined;
  server.onConnection((connection) => {
    accepted = connection;
    connection.onMessage((text) => connection.sendText(`echo:${text}`));
  });
  await server.listen();
  context.after(async () => { await server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const { socket, inbox } = await open(`ws://127.0.0.1:${address.port}/socket`);
  context.after(() => socket.close());
  socket.send("hello");
  assert.equal(await inbox.next(), "echo:hello");
  assert.ok(accepted);
  const before = accepted.lastPongAt;
  accepted.ping(Buffer.from("heartbeat"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(accepted.lastPongAt >= before);
});

test("WebSocket server rejects upgrades on the wrong path", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/right" });
  await server.listen();
  context.after(async () => { await server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/wrong`);
  await assert.rejects(async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for path rejection")), 2_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Upgrade rejected")); }, { once: true });
    });
  }, /Upgrade rejected/u);
  socket.close();
});
