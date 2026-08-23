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
        context: {
          imageAttachments: [{ filename: "screen.png", mimeType: "image/png", previewSrc: "data:image/png;base64,AQID" }],
          fileAttachments: [
            { name: "notes.md", mimeType: "text/markdown", size: 42 },
            { filename: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, src: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 },
          ],
          appshotContexts: [{ title: "Browser capture", imageDataUrl: "data:image/jpeg;base64,BwgJ" }],
          mcpAppModelContextAttachments: [{ name: "MCP image", src: "data:image/webp;base64,CgsM" }],
          pastedTextAttachments: [{ filename: "Pasted text.txt", byteLength: 12 }],
        },
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
    attachments: [
      { name: "screen.png", mimeType: "image/png", byteLength: 3, dataUrl: "data:image/png;base64,AQID" },
      { name: "Browser capture", mimeType: "image/jpeg", byteLength: 3, dataUrl: "data:image/jpeg;base64,BwgJ" },
      { name: "MCP image", mimeType: "image/webp", byteLength: 3, dataUrl: "data:image/webp;base64,CgsM" },
      { name: "notes.md", mimeType: "text/markdown", byteLength: 42 },
      { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 },
      { name: "Pasted text.txt", mimeType: "text/plain", byteLength: 12 },
    ],
  }]);
});

test("Codex queue keeps an image widget when preview bytes are unsafe or too large", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-preview-"));
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({
    "queued-follow-ups": {
      thread: [{
        id: "bounded-preview",
        text: "Inspect these images",
        context: { imageAttachments: [
          { filename: "remote.png", previewSrc: "https://example.test/private.png" },
          { filename: "large.png", previewSrc: `data:image/png;base64,${"A".repeat(192 * 1024 + 1)}` },
        ] },
        cwd: "C:\\work",
        createdAt: Date.parse("2026-08-16T04:00:00.000Z"),
      }],
    },
  }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const queue = new CodexDesktopQueue({ statePath, pipePath: "unused", onChanged: () => undefined });
  t.after(() => queue.dispose());
  await queue.start();

  assert.deepEqual(queue.list()[0]?.attachments, [
    { name: "remote.png", mimeType: "image/png", byteLength: 0 },
    { name: "large.png", mimeType: "image/png", byteLength: 0 },
  ]);
});

test("Codex starts one native audio turn through the Desktop task owner", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-audio-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-audio-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");

  const requests: Record<string, unknown>[] = [];
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
        requests.push(request);
        const response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "audio-test-client" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "desktop-owner" }
              : request.method === "thread-follower-start-turn"
                ? { method: request.method, result: { result: { turn: { id: "turn-audio" } } } }
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
  const result = await queue.startTurn("thread-audio", {
    requestId: "audio-message-1",
    content: "",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    attachments: [{ name: "voice.mp3", mimeType: "audio/mpeg", dataBase64: "AQID", byteLength: 3 }],
  });

  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-audio", details: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn",
  ]);
  const forwarded = requests[2]!;
  assert.equal(forwarded.targetClientId, "desktop-owner");
  assert.equal(forwarded.version, 1);
  assert.deepEqual(forwarded.params, {
    conversationId: "thread-audio",
    turnStart: {
      request: {
        threadId: "thread-audio",
        clientUserMessageId: "audio-message-1",
        input: [
          { type: "text", text: "", text_elements: [] },
          { type: "audio", url: "data:audio/mpeg;base64,AQID" },
        ],
        model: "gpt-5.6-sol",
        effort: "high",
      },
    },
  });
  assert.equal(requests.some((request) => request.method === "thread-follower-set-queued-follow-ups-state"), false);
});

test("Codex rejects a Desktop audio acknowledgement without a confirmed turn id", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-audio-unconfirmed-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-audio-unconfirmed-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");

  const requests: Record<string, unknown>[] = [];
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
        requests.push(request);
        const response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "audio-unconfirmed-client" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "desktop-owner" }
              : request.method === "thread-follower-start-turn"
                ? { method: request.method, result: { result: {} } }
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
  await assert.rejects(() => queue.startTurn("thread-audio", {
    requestId: "audio-message-unconfirmed",
    content: "",
    attachments: [{ name: "voice.mp3", mimeType: "audio/mpeg", dataBase64: "AQID", byteLength: 3 }],
  }), /did not confirm that the audio turn started/);
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn",
  ]);
});

test("Codex steers a native queued message through its Desktop owner with the exact restore context", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-${process.pid}-${randomUUID()}`;
  const queued = {
    id: "queued-steer",
    text: "Please use the narrower trace",
    context: { prompt: "Please use the narrower trace", workspaceRoots: ["C:\\work"], imageAttachments: [{ id: "image-1", src: "data:image/png;base64,AQID" }] },
    cwd: "C:\\work",
    createdAt: Date.parse("2026-08-22T03:00:00.000Z"),
    mentionedBrowserFamilies: [],
    pausedReason: null,
  };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");

  const requests: Record<string, unknown>[] = [];
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
        requests.push(request);
        const response = {
          type: "response", requestId: request.requestId, resultType: "success",
          ...(request.method === "initialize" ? { result: { clientId: "steer-test-client" } }
            : request.method === "thread-owner-discovery" ? { handledByClientId: "desktop-owner" }
              : request.method === "thread-follower-steer-turn" ? { method: request.method, result: { result: { turnId: "turn-steered" } } }
                : {}),
        };
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  const result = await queue.steerQueuedMessage("thread", queued.id, { requestId: "ignored-in-favour-of-native-id", content: queued.text });

  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-steered", details: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize", "thread-owner-discovery", "thread-follower-set-queued-follow-ups-state", "thread-follower-steer-turn",
  ]);
  const removal = requests[2]!.params as Record<string, unknown>;
  assert.deepEqual(removal.state, {});
  const steer = requests[3]!;
  assert.equal(steer.targetClientId, "desktop-owner");
  assert.equal(steer.version, 1);
  assert.deepEqual(steer.params, {
    conversationId: "thread",
    input: [{ type: "text", text: queued.text, text_elements: [] }],
    restoreMessage: queued,
    serviceTier: null,
    attachments: [],
    clientUserMessageId: queued.id,
  });
});

test("Codex restores the exact native queue record when Desktop-owner steering fails", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-fail-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-fail-${process.pid}-${randomUUID()}`;
  const queued = { id: "restore-me", text: "Keep every field", context: { prompt: "Keep every field", fileAttachments: [{ id: "file-1", name: "proof.txt" }] }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: ["chrome"], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");
  const queueStates: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0); if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>; buffer = buffer.subarray(length + 4);
        if (request.method === "thread-follower-set-queued-follow-ups-state") queueStates.push((request.params as Record<string, unknown>).state);
        const failed = request.method === "thread-follower-steer-turn";
        const response = { type: "response", requestId: request.requestId, resultType: failed ? "error" : "success",
          ...(request.method === "initialize" ? { result: { clientId: "fail-client" } } : request.method === "thread-owner-discovery" ? { handledByClientId: "desktop-owner" } : failed ? { error: "NoActiveTurn" } : {}) };
        const body = Buffer.from(JSON.stringify(response), "utf8"); const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(() => queue.steerQueuedMessage("thread", queued.id, { requestId: "steer", content: queued.text }), /NoActiveTurn/);
  assert.deepEqual(queueStates, [{}, { thread: [queued] }]);
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
