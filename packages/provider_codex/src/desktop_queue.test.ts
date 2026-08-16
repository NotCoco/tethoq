import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexDesktopQueue } from "./desktop_queue.js";

test("Codex reads current Desktop queue records without the removed browser-family field", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-current-"));
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({
    "queued-follow-ups": {
      thread: [{
        id: "current-shape",
        text: "Queued in Codex Desktop",
        context: {},
        cwd: "C:\\work",
        createdAt: Date.parse("2026-08-16T04:00:00.000Z"),
        pausedReason: null,
      }],
    },
  }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const queue = new CodexDesktopQueue({ statePath, pipePath: "unused", onChanged: () => undefined });
  t.after(() => queue.dispose());
  await queue.start();

  assert.deepEqual(queue.list(), [{
    id: "current-shape",
    providerSessionId: "thread",
    content: "Queued in Codex Desktop",
    state: "queued",
    createdAt: "2026-08-16T04:00:00.000Z",
  }]);
});

test("Codex restores a failed manual delivery at its original queue position", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-queue-${process.pid}-${randomUUID()}`;
  const second = {
    id: "second",
    text: "Second instruction",
    context: {},
    cwd: "C:\\work",
    createdAt: Date.parse("2026-08-15T10:00:01.000Z"),
    mentionedBrowserFamilies: [],
    pausedReason: null,
  };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [second] } }), "utf8");

  let replacedState: unknown;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        const params = request.params as Record<string, unknown> | undefined;
        if (request.method === "thread-follower-set-queued-follow-ups-state") replacedState = params?.state;
        const response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "queue-test-client" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "queue-owner" }
              : {}),
        };
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  const restored = await queue.restore("thread", {
    requestId: "restore-first",
    content: "First instruction",
    developerInstructions: "Keep this response concise.",
    workingDirectory: "C:\\work",
    originalMessage: {
      id: "first",
      providerSessionId: "thread",
      content: "First instruction",
      state: "queued",
      createdAt: "2026-08-15T10:00:00.000Z",
      developerInstructions: "Keep this response concise.",
    },
    beforeMessageId: "second",
  });

  assert.equal(restored.id, "first");
  assert.equal(restored.createdAt, "2026-08-15T10:00:00.000Z");
  assert.equal(restored.developerInstructions, "Keep this response concise.");
  const conversation = (replacedState as Record<string, unknown>)?.thread;
  assert.ok(Array.isArray(conversation));
  assert.deepEqual(conversation.map((message) => (message as Record<string, unknown>).id), ["first", "second"]);
  assert.equal(((conversation[0] as Record<string, unknown>).context as Record<string, unknown>).tethoqDeveloperInstructions, "Keep this response concise.");
});
