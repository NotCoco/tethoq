import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { ProviderAdapterError } from "../../provider_contract/src/index.js";
import { CodexDesktopQueue } from "./desktop_queue.js";

class FakeQueueWatcher extends EventEmitter {
  public closeCalls = 0;

  public close(): void {
    this.closeCalls += 1;
  }
}

function fakeWatcher(value: FakeQueueWatcher): FSWatcher {
  return value as unknown as FSWatcher;
}

test("Codex queued Edit reads original bytes and keeps identically named attachments distinct", async t => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-draft-"));
  const statePath = join(root, "state.json"), filePath = join(root, "notes.md");
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const image = Buffer.alloc(800_001, 71), notes = Buffer.from("Original notes");
  await writeFile(filePath, notes);
  const state = JSON.stringify({ "queued-follow-ups": { thread: [{ id: "draft", text: "Edit this", cwd: root, createdAt: Date.now(), context: {
    imageAttachments: [
      { filename: "same.png", mimeType: "image/png", byteLength: image.length, uploadSrc: "https://example.invalid/image", src: `data:image/png;base64,${image.toString("base64")}`, previewSrc: "data:image/png;base64,AQID" },
      { filename: "same.png", mimeType: "image/png", byteLength: 3, src: "data:image/png;base64,BAUG" },
    ],
    fileAttachments: [{ filename: "notes.md", mimeType: "text/markdown", byteLength: notes.length, localPath: filePath }],
  } }] } });
  await writeFile(statePath, state);
  const queue = new CodexDesktopQueue({ statePath, pipePath: "unused", onChanged: () => undefined });
  t.after(() => queue.dispose());
  await queue.start();
  const draft = await queue.readMessage("thread", "draft");
  assert.equal(draft?.content, "Edit this");
  assert.deepEqual(draft?.attachments?.map(item => Buffer.from(item.dataBase64, "base64")), [image, Buffer.from([4, 5, 6]), notes]);
  assert.equal(await queue.cancel("thread", "draft", "Stale text"), false);
  assert.equal(await readFile(statePath, "utf8"), state, "reading a draft or rejecting a stale cancellation must leave the native queue intact");
  await rm(filePath);
  await assert.rejects(queue.readMessage("thread", "draft"), /ENOENT/);
  assert.equal(await readFile(statePath, "utf8"), state, "missing files must not dequeue the message");
});

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

test("Codex queue re-arms one watcher after an asynchronous watcher error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-watcher-"));
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const watchers: FakeQueueWatcher[] = [];
  let resolveRearmed!: () => void;
  const rearmed = new Promise<void>((resolve) => { resolveRearmed = resolve; });
  const queue = new CodexDesktopQueue({
    statePath,
    pipePath: "unused",
    watchFactory: () => {
      const watcher = new FakeQueueWatcher();
      watchers.push(watcher);
      if (watchers.length === 2) resolveRearmed();
      return fakeWatcher(watcher);
    },
    onChanged: () => undefined,
  });
  t.after(() => queue.dispose());

  await queue.start();
  assert.equal(watchers.length, 1);
  watchers[0]!.emit("error", new Error("watcher failed asynchronously"));
  watchers[0]!.emit("error", new Error("the dead watcher reported again"));
  await queue.start();

  await Promise.race([
    rearmed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("watcher was not re-armed")), 1_000)),
  ]);
  assert.equal(watchers[0]!.closeCalls, 1);
  assert.equal(watchers.length, 2, "the error and concurrent start must share one replacement watcher");

  await queue.start();
  assert.equal(watchers.length, 2, "starting with a live replacement must not create a duplicate watcher");
});

test("Codex queue catches up changes made while its watcher is re-arming", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-watcher-gap-"));
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const watchers: FakeQueueWatcher[] = [];
  let resolveRearmed!: () => void;
  const rearmed = new Promise<void>((resolve) => { resolveRearmed = resolve; });
  let resolveUpdated!: () => void;
  const updated = new Promise<void>((resolve) => { resolveUpdated = resolve; });
  const queue = new CodexDesktopQueue({
    statePath,
    pipePath: "unused",
    watchFactory: () => {
      const watcher = new FakeQueueWatcher();
      watchers.push(watcher);
      if (watchers.length === 2) resolveRearmed();
      return fakeWatcher(watcher);
    },
    onChanged: (messages) => {
      if (messages.some((message) => message.id === "during-watcher-gap")) resolveUpdated();
    },
  });
  t.after(() => queue.dispose());

  await queue.start();
  watchers[0]!.emit("error", new Error("watcher failed before the native write"));
  await writeFile(statePath, JSON.stringify({
    "queued-follow-ups": {
      thread: [{
        id: "during-watcher-gap",
        text: "Queued while Tethoq re-armed its watcher",
        context: {},
        cwd: "C:\\work",
        createdAt: Date.parse("2026-08-30T05:00:00.000Z"),
      }],
    },
  }), "utf8");

  await Promise.race([
    rearmed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("watcher was not re-armed")), 1_000)),
  ]);
  await Promise.race([
    updated,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("queue did not catch up after watcher re-arm")), 1_000)),
  ]);
  assert.deepEqual(queue.list().map((message) => message.id), ["during-watcher-gap"]);
});

test("Codex queue preserves its last confirmed rows when a refresh cannot read state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-refresh-"));
  const statePath = join(root, "state.json");
  const state = {
    "queued-follow-ups": {
      thread: [{
        id: "keep-on-read-failure",
        text: "Keep this queued",
        context: {},
        cwd: "C:\\work",
        createdAt: Date.parse("2026-08-28T10:00:00.000Z"),
      }],
    },
  };
  await writeFile(statePath, JSON.stringify(state), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const updates: (readonly string[])[] = [];
  const queue = new CodexDesktopQueue({
    statePath,
    pipePath: "unused",
    watchFactory: () => fakeWatcher(new FakeQueueWatcher()),
    onChanged: (messages) => { updates.push(messages.map((message) => message.id)); },
  });
  t.after(() => queue.dispose());

  await queue.start();
  assert.deepEqual(queue.list().map((message) => message.id), ["keep-on-read-failure"]);
  assert.deepEqual(updates, [["keep-on-read-failure"]]);

  await writeFile(statePath, "{ temporarily incomplete", "utf8");
  await queue.start();
  assert.deepEqual(queue.list().map((message) => message.id), ["keep-on-read-failure"]);
  assert.deepEqual(updates, [["keep-on-read-failure"]], "a read failure must not publish a false empty queue");

  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  await queue.start();
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(updates, [["keep-on-read-failure"], []], "a later valid refresh must still apply normally");
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
          { filename: "large.png", previewSrc: `data:image/png;base64,${"A".repeat(256 * 1024 + 4)}` },
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

test("Codex queue retains the bounded thumbnail from an ordinary Desktop screenshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-screenshot-preview-"));
  const statePath = join(root, "state.json");
  const encodedScreenshot = `${"A".repeat(210_091)}=`;
  const preview = `data:image/png;base64,${encodedScreenshot}`;
  await writeFile(statePath, JSON.stringify({
    "queued-follow-ups": {
      thread: [{
        id: "ordinary-screenshot",
        text: "Inspect this screenshot",
        context: { imageAttachments: [{
          filename: "image.png",
          localPath: "C:\\Temp\\image.png",
          src: preview,
        }] },
        cwd: "C:\\work",
        createdAt: Date.parse("2026-08-28T22:00:00.000Z"),
      }],
    },
  }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const queue = new CodexDesktopQueue({ statePath, pipePath: "unused", onChanged: () => undefined });
  t.after(() => queue.dispose());
  await queue.start();

  const attachment = queue.list()[0]?.attachments?.[0];
  assert.equal(attachment?.name, "image.png");
  assert.equal(attachment?.mimeType, "image/png");
  assert.equal(attachment?.byteLength, 157_568);
  assert.equal(attachment?.dataUrl === preview, true, "an ordinary native screenshot should reach the thumbnail renderer unchanged");
});

test("Codex reports an unavailable Desktop queue owner before any native mutation", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-queue-no-owner-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-queue-no-owner-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(
    () => queue.enqueue("thread", {
      requestId: "queue-without-owner",
      content: "Keep this locally instead",
      workingDirectory: "C:\\work",
    }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "PROVIDER_QUEUE_OWNER_UNAVAILABLE",
  );
  assert.deepEqual(queue.list(), []);
});

test("Codex queues text and images durably once across failure, retry, and restart", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-image-queue-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-image-queue-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");

  const queueStates: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let failNextQueueWrite = true;
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
        const respond = (response: Record<string, unknown>): void => {
          const body = Buffer.from(JSON.stringify(response), "utf8");
          const frame = Buffer.allocUnsafe(body.length + 4);
          frame.writeUInt32LE(body.length, 0);
          body.copy(frame, 4);
          socket.write(frame);
        };
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          const state = (request.params as Record<string, unknown>).state as Record<string, unknown>;
          queueStates.push(state);
          if (failNextQueueWrite) {
            failNextQueueWrite = false;
            respond({ type: "response", requestId: request.requestId, resultType: "error", error: "temporary-write-failure" });
          } else {
            void writeFile(statePath, JSON.stringify({ "queued-follow-ups": state }), "utf8").then(() => {
              respond({ type: "response", requestId: request.requestId, resultType: "success" });
            });
          }
          continue;
        }
        respond({
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize"
            ? { result: { clientId: "image-queue-client" } }
            : request.method === "thread-owner-discovery"
              ? { handledByClientId: "desktop-owner" }
              : {}),
        });
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

  const request = {
    requestId: "stable-image-request",
    content: "Compare these in order",
    workingDirectory: "C:\\work",
    attachments: [
      { name: "first.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 },
      { name: "second.jpg", mimeType: "image/jpeg", dataBase64: "BAUG", byteLength: 3 },
    ],
  };
  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(() => queue.enqueue("thread", request), /temporary-write-failure/);
  const accepted = await queue.enqueue("thread", request);
  assert.deepEqual(accepted.attachments, [
    { name: "first.png", mimeType: "image/png", byteLength: 3, dataUrl: "data:image/png;base64,AQID" },
    { name: "second.jpg", mimeType: "image/jpeg", byteLength: 3, dataUrl: "data:image/jpeg;base64,BAUG" },
  ]);
  assert.equal((await queue.enqueue("thread", request)).id, accepted.id, "an in-process retry must reuse the native row");

  const restarted = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.enqueue("thread", request)).id, accepted.id, "a restart retry must reuse the native row");
  await assert.rejects(
    () => restarted.enqueue("thread", { ...request, content: "Different payload" }),
    /request ID is already in use/,
  );

  assert.equal(queueStates.length, 2, "one failed write and one successful write are the only native mutations");
  const stored = ((queueStates[1]!.thread as unknown[]) ?? []) as Record<string, unknown>[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.id, accepted.id);
  const context = stored[0]?.context as Record<string, unknown>;
  assert.equal(context.prompt, request.content);
  assert.equal(context.tethoqRequestId, request.requestId);
  assert.match(String(context.tethoqRequestHash), /^[a-f0-9]{64}$/u);
  assert.deepEqual(context.imageAttachments, [
    { id: `${accepted.id}:image:0`, filename: "first.png", mimeType: "image/png", byteLength: 3, src: "data:image/png;base64,AQID" },
    { id: `${accepted.id}:image:1`, filename: "second.jpg", mimeType: "image/jpeg", byteLength: 3, src: "data:image/jpeg;base64,BAUG" },
  ]);

  const secondRequest = { ...request, requestId: "ordered-second", content: "Second queued turn" };
  const thirdRequest = { ...request, requestId: "ordered-third", content: "Third queued turn" };
  const [second, cancelled, third] = await Promise.all([
    restarted.enqueue("thread", secondRequest),
    restarted.cancel("thread", accepted.id),
    restarted.enqueue("thread", thirdRequest),
  ]);
  assert.equal(cancelled, true);
  assert.deepEqual(restarted.list().map((message) => [message.id, message.content]), [
    [second.id, secondRequest.content],
    [third.id, thirdRequest.content],
  ], "concurrent native mutations must not lose or reorder queue rows");
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
        const supportedVersion = request.method === "initialize"
          || (request.method === "thread-owner-discovery" && request.version === 1)
          || (request.method === "thread-follower-start-turn" && request.version === 2);
        const response = supportedVersion ? {
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
        } : {
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "no-client-found",
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
  }, [{ type: "function", name: "ask_eyes", description: "Ask visual support", inputSchema: { type: "object" } }]);

  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-audio", details: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn",
  ]);
  const forwarded = requests[2]!;
  assert.equal(forwarded.targetClientId, "desktop-owner");
  assert.equal(requests[1]?.version, 1);
  assert.equal(forwarded.version, 2);
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
        dynamicTools: [{ type: "function", name: "ask_eyes", description: "Ask visual support", inputSchema: { type: "object" } }],
      },
    },
  });
  assert.equal(requests.some((request) => request.method === "thread-follower-set-queued-follow-ups-state"), false);
  requests.length = 0;
  await queue.startTurn("thread-audio", {
    requestId: "continue-button", content: "<tethoq_hidden_control_turn>continue</tethoq_hidden_control_turn>",
    modelId: "gpt-5.6-sol", reasoningEffort: "high",
  });
  const continued = requests.find(request => request.method === "thread-follower-start-turn")!;
  assert.deepEqual(continued.params, {
    conversationId: "thread-audio",
    turnStart: { request: { threadId: "thread-audio", clientUserMessageId: "continue-button", input: [], model: "gpt-5.6-sol", effort: "high" } },
  });
});

test("Codex rediscovers a replaced Desktop owner after a no-client-found routing failure", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-refresh-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-refresh-${process.pid}-${randomUUID()}`;
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": {} }), "utf8");

  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let ownerDiscoveries = 0;
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
        if (request.method === "thread-owner-discovery") ownerDiscoveries += 1;
        const response = {
          type: "response",
          requestId: request.requestId,
          ...(request.method === "thread-follower-start-turn" && request.targetClientId === "stale-owner"
            ? { resultType: "error", error: "no-client-found" }
            : {
                resultType: "success",
                ...(request.method === "initialize"
                  ? { result: { clientId: "owner-refresh-client" } }
                  : request.method === "thread-owner-discovery"
                    ? { handledByClientId: ownerDiscoveries === 1 ? "stale-owner" : "fresh-owner" }
                    : request.method === "thread-follower-start-turn"
                      ? { result: { result: { turn: { id: "turn-refreshed" } } } }
                      : {}),
              }),
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
  const result = await queue.startTurn("thread-image", {
    requestId: "image-message-1",
    content: "Review this image",
    attachments: [{ name: "image.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 }],
  });

  assert.deepEqual(result, { accepted: true, providerTurnId: "turn-refreshed", details: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn",
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn",
  ]);
  const starts = requests.filter((request) => request.method === "thread-follower-start-turn");
  assert.deepEqual(starts.map((request) => request.targetClientId), ["stale-owner", "fresh-owner"]);
  assert.deepEqual(starts.map((request) => request.version), [2, 2]);
  assert.deepEqual(starts.map((request) => ((request.params as Record<string, unknown>).turnStart as Record<string, unknown>)), [
    ((starts[0]!.params as Record<string, unknown>).turnStart as Record<string, unknown>),
    ((starts[0]!.params as Record<string, unknown>).turnStart as Record<string, unknown>),
  ]);
});

test("Codex reports an unavailable Desktop owner without attempting a second writer", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-missing-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-missing-${process.pid}-${randomUUID()}`;
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
          ...(request.method === "initialize" ? { result: { clientId: "owner-missing-client" } } : {}),
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

  const queue = new CodexDesktopQueue({ statePath, pipePath, ownerRecoveryWindowMs: 0, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(() => queue.startTurn("thread-image", {
    requestId: "image-message-owner-missing",
    content: "Review this image",
    attachments: [
      { name: "first.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 },
      { name: "second.png", mimeType: "image/png", dataBase64: "BAUG", byteLength: 3 },
    ],
  }), /another writer.*did not become reachable.*draft is unchanged/iu);
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
  ]);
  assert.equal(requests.some((request) => request.method === "thread-follower-start-turn"), false);
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
  }), (error: unknown) => error instanceof ProviderAdapterError
    && error.code === "DELIVERY_UNKNOWN"
    && !error.retryable);
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

test("Codex keeps queued steering alive beyond the Desktop handler's five-second wait", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-delay-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-delay-${process.pid}-${randomUUID()}`;
  const queued = {
    id: "delayed-steer",
    text: "Wait for the active turn id",
    context: {},
    cwd: "C:\\work",
    createdAt: Date.parse("2026-08-28T14:53:00.000Z"),
    mentionedBrowserFamilies: [],
    pausedReason: null,
  };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");

  const queueStates: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const respond = (request: Record<string, unknown>, response: Record<string, unknown>) => {
      if (socket.destroyed) return;
      const body = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, ...response }), "utf8");
      const frame = Buffer.allocUnsafe(body.length + 4);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);
      socket.write(frame);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          queueStates.push((request.params as Record<string, unknown>).state);
        }
        if (request.method === "thread-follower-steer-turn") {
          setTimeout(() => respond(request, {
            resultType: "success",
            method: request.method,
            result: { result: { turnId: "delayed-turn-id" } },
          }), 5_250);
          continue;
        }
        respond(request, {
          resultType: "success",
          ...(request.method === "initialize" ? { result: { clientId: "delayed-steer-client" } }
            : request.method === "thread-owner-discovery" ? { handledByClientId: "desktop-owner" }
              : {}),
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, requestTimeoutMs: 100, onChanged: () => undefined });
  t.after(() => queue.dispose());
  const result = await queue.steerQueuedMessage("thread", queued.id, { requestId: "delayed-steer-request", content: queued.text });

  assert.deepEqual(result, { accepted: true, providerTurnId: "delayed-turn-id", details: [] });
  assert.deepEqual(queueStates, [{}], "a delayed successful steer must not restore the already-delivered queue row");
});

test("Codex retries explicit Desktop NoActiveTurn through a freshly discovered owner", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-retry-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-retry-${process.pid}-${randomUUID()}`;
  const queued = { id: "retry-me", text: "Keep the native request identity", context: { prompt: "Keep the native request identity", fileAttachments: [{ id: "file-1", name: "proof.txt" }] }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: ["chrome"], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");
  const requests: Record<string, unknown>[] = [];
  const queueStates: unknown[] = [];
  let ownerDiscoveries = 0;
  let steerAttempts = 0;
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
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          queueStates.push((request.params as Record<string, unknown>).state);
        }
        const response = request.method === "thread-follower-steer-turn"
          ? steerAttempts++ === 0
            ? { type: "response", requestId: request.requestId, resultType: "error", error: "NoActiveTurn" }
            : { type: "response", requestId: request.requestId, resultType: "success", result: { result: { turnId: "retried-turn" } } }
          : {
              type: "response",
              requestId: request.requestId,
              resultType: "success",
              ...(request.method === "initialize" ? { result: { clientId: `retry-client-${requests.length}` } }
                : request.method === "thread-owner-discovery" ? { handledByClientId: `desktop-owner-${++ownerDiscoveries}` }
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, ownerRetryDelayMs: 1, onChanged: () => undefined });
  t.after(() => queue.dispose());
  const result = await queue.steerQueuedMessage("thread", queued.id, { requestId: "bridge-attempt-id", content: queued.text });

  assert.deepEqual(result, { accepted: true, providerTurnId: "retried-turn", details: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-steer-turn",
    "thread-follower-set-queued-follow-ups-state",
    "initialize",
    "thread-owner-discovery",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-steer-turn",
  ]);
  assert.deepEqual(queueStates, [
    {},
    { thread: [queued] },
    {},
  ], "the exact native row must be restored before the safe retry removes it again");
  const steerRequests = requests.filter((request) => request.method === "thread-follower-steer-turn");
  assert.deepEqual(steerRequests.map((request) => request.targetClientId), ["desktop-owner-1", "desktop-owner-2"]);
  assert.deepEqual(steerRequests.map((request) => request.params), [
    {
      conversationId: "thread",
      input: [{ type: "text", text: queued.text, text_elements: [] }],
      restoreMessage: queued,
      serviceTier: null,
      attachments: [],
      clientUserMessageId: queued.id,
    },
    {
      conversationId: "thread",
      input: [{ type: "text", text: queued.text, text_elements: [] }],
      restoreMessage: queued,
      serviceTier: null,
      attachments: [],
      clientUserMessageId: queued.id,
    },
  ]);
  assert.deepEqual(queue.list(), [], "a confirmed retry must leave the delivered row consumed");
});

test("Codex keeps the exact native row retryable when Desktop IPC is unavailable before steer", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-connect-fail-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-missing-${process.pid}-${randomUUID()}`;
  const queued = { id: "connect-failure-row", text: "Keep this exact row", context: { prompt: "Keep this exact row" }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: [], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await queue.start();
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", queued.id, { requestId: "durable-connect-failure", content: queued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "PROVIDER_QUEUE_OWNER_UNAVAILABLE"
      && error.retryable,
  );

  assert.deepEqual(queue.list().map(({ id, content, state }) => ({ id, content, state })), [{
    id: queued.id,
    content: queued.text,
    state: "queued",
  }]);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(persisted, { "queued-follow-ups": { thread: [queued] } });
});

test("Codex NoActiveTurn recovery preserves Desktop queue additions and the native steer identity", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-concurrent-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-concurrent-${process.pid}-${randomUUID()}`;
  const queued = { id: "restore-target", text: "Steer only this row", context: { prompt: "Steer only this row", imageAttachments: [{ id: "image-1", src: "data:image/png;base64,AQID" }] }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: [], pausedReason: null };
  const added = { id: "desktop-added", text: "Added while steer waited", context: { prompt: "Added while steer waited" }, cwd: "C:\\work", createdAt: 1787367600001, mentionedBrowserFamilies: [], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");

  const requests: Record<string, unknown>[] = [];
  const queueStates: unknown[] = [];
  let steerAttempts = 0;
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
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          const state = (request.params as Record<string, unknown>).state;
          queueStates.push(state);
          writeFileSync(statePath, JSON.stringify({ "queued-follow-ups": state }), "utf8");
        }
        let response: Record<string, unknown>;
        if (request.method === "initialize") {
          response = { type: "response", requestId: request.requestId, resultType: "success", result: { clientId: `concurrent-client-${requests.length}` } };
        } else if (request.method === "thread-owner-discovery") {
          response = { type: "response", requestId: request.requestId, resultType: "success", handledByClientId: "desktop-owner" };
        } else if (request.method === "thread-follower-steer-turn" && steerAttempts++ === 0) {
          // Desktop adds another row after Tethoq's removal but before the
          // definitive rejection arrives. Recovery must merge, not overwrite it.
          writeFileSync(statePath, JSON.stringify({ "queued-follow-ups": { thread: [added] } }), "utf8");
          response = { type: "response", requestId: request.requestId, resultType: "error", error: "NoActiveTurn" };
        } else if (request.method === "thread-follower-steer-turn") {
          response = { type: "response", requestId: request.requestId, resultType: "success", result: { result: { turnId: "concurrent-retry-turn" } } };
        } else {
          response = { type: "response", requestId: request.requestId, resultType: "success" };
        }
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, ownerRetryDelayMs: 1, onChanged: () => undefined });
  t.after(() => queue.dispose());
  const result = await queue.steerQueuedMessage("thread", queued.id, { requestId: "durable-concurrent-retry", content: queued.text });

  assert.deepEqual(result, { accepted: true, providerTurnId: "concurrent-retry-turn", details: [] });
  assert.deepEqual(queueStates, [
    {},
    { thread: [queued, added] },
    { thread: [added] },
  ], "recovery restores only the removed row and retains the Desktop-side addition");
  const steers = requests.filter((request) => request.method === "thread-follower-steer-turn");
  assert.equal(steers.length, 2);
  assert.deepEqual(steers.map((request) => (request.params as Record<string, unknown>).clientUserMessageId), [queued.id, queued.id]);
  assert.deepEqual(steers.map((request) => (request.params as Record<string, unknown>).restoreMessage), [queued, queued]);
  assert.deepEqual(queue.list().map(({ id, content }) => ({ id, content })), [{ id: added.id, content: added.text }]);
});

test("Codex keeps a restored NoActiveTurn row singular when fresh owner discovery fails", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-rediscovery-fail-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-rediscovery-fail-${process.pid}-${randomUUID()}`;
  const queued = { id: "rediscovery-row", text: "Keep one restored instruction", context: { prompt: "Keep one restored instruction" }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: [], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");

  const requests: Record<string, unknown>[] = [];
  let ownerDiscoveries = 0;
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
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          const state = (request.params as Record<string, unknown>).state;
          writeFileSync(statePath, JSON.stringify({ "queued-follow-ups": state }), "utf8");
        }
        const response = request.method === "initialize"
          ? { type: "response", requestId: request.requestId, resultType: "success", result: { clientId: `rediscovery-client-${requests.length}` } }
          : request.method === "thread-owner-discovery"
            ? ++ownerDiscoveries === 1
              ? { type: "response", requestId: request.requestId, resultType: "success", handledByClientId: "desktop-owner" }
              : { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }
            : request.method === "thread-follower-steer-turn"
              ? { type: "response", requestId: request.requestId, resultType: "error", error: "NoActiveTurn" }
              : { type: "response", requestId: request.requestId, resultType: "success" };
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.length + 4);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, ownerRetryDelayMs: 1, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", queued.id, { requestId: "durable-rediscovery", content: queued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "NO_ACTIVE_TURN"
      && error.retryable,
  );

  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-steer-turn",
    "thread-follower-set-queued-follow-ups-state",
    "initialize",
    "thread-owner-discovery",
  ]);
  const steers = requests.filter((request) => request.method === "thread-follower-steer-turn");
  assert.equal(steers.length, 1, "failed rediscovery must not emit a second steer frame");
  assert.equal((steers[0]!.params as Record<string, unknown>).clientUserMessageId, queued.id);
  assert.deepEqual(queue.list().map(({ id, content, state }) => ({ id, content, state })), [{
    id: queued.id,
    content: queued.text,
    state: "queued",
  }]);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(persisted, { "queued-follow-ups": { thread: [queued] } });
});

test("Codex bounds explicit Desktop NoActiveTurn retries and restores only definite rejections", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-fail-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-fail-${process.pid}-${randomUUID()}`;
  const queued = { id: "restore-me", text: "Keep every field", context: { prompt: "Keep every field", fileAttachments: [{ id: "file-1", name: "proof.txt" }] }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: ["chrome"], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [queued] } }), "utf8");
  const queueStates: unknown[] = [];
  const noActiveTurnErrors = [
    "NoActiveTurn",
    "NO_ACTIVE_TURN",
    "No active Codex turn is available to steer",
  ] as const;
  const steerErrors = [
    noActiveTurnErrors[0],
    noActiveTurnErrors[1],
    noActiveTurnErrors[2],
    "Desktop owner failed after forwarding",
  ];
  let steerAttempts = 0;
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
          ...(request.method === "initialize" ? { result: { clientId: "fail-client" } } : request.method === "thread-owner-discovery" ? { handledByClientId: "desktop-owner" } : failed ? { error: steerErrors[steerAttempts++] } : {}) };
        const body = Buffer.from(JSON.stringify(response), "utf8"); const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

  const queue = new CodexDesktopQueue({ statePath, pipePath, ownerRetryDelayMs: 1, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", queued.id, { requestId: "steer-bounded", content: queued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "NO_ACTIVE_TURN"
      && error.retryable,
  );
  assert.deepEqual(queue.list().map((message) => message.id), [queued.id]);
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", queued.id, { requestId: "steer-unclassified", content: queued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "DELIVERY_UNKNOWN"
      && !error.retryable,
  );
  assert.deepEqual(queueStates, [
    {}, { thread: [queued] },
    {}, { thread: [queued] },
    {}, { thread: [queued] },
    {},
  ]);
  assert.deepEqual(queue.list(), [], "an unclassified owner error must not recreate an instruction that may already have been delivered");
});

test("Codex does not restore or retry native queued steers after timeout or pipe loss", {
  skip: process.platform !== "win32",
  timeout: 5_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "tethoq-codex-owner-steer-unknown-"));
  const statePath = join(root, "state.json");
  const pipePath = `\\\\.\\pipe\\tethoq-owner-steer-unknown-${process.pid}-${randomUUID()}`;
  const timeoutQueued = { id: "timed-out-after-write", text: "Never retry this timed-out steer", context: { prompt: "Never retry this timed-out steer" }, cwd: "C:\\work", createdAt: 1787367600000, mentionedBrowserFamilies: [], pausedReason: null };
  const pipeQueued = { id: "pipe-lost-after-write", text: "Never retry this disconnected steer", context: { prompt: "Never retry this disconnected steer" }, cwd: "C:\\work", createdAt: 1787367600001, mentionedBrowserFamilies: [], pausedReason: null };
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [timeoutQueued, pipeQueued] } }), "utf8");
  const requests: Record<string, unknown>[] = [];
  const queueStates: unknown[] = [];
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
        if (request.method === "thread-follower-set-queued-follow-ups-state") {
          queueStates.push((request.params as Record<string, unknown>).state);
        }
        if (request.method === "thread-follower-steer-turn") {
          // The owner received the steer, but the transport disappears before
          // Tethoq can know whether it accepted the instruction. Exercise both
          // timeout and immediate pipe-loss acknowledgements without waiting
          // forty wall-clock seconds for the native handler budget.
          if ((request.params as Record<string, unknown>).clientUserMessageId === timeoutQueued.id) {
            t.mock.timers.tick(40_001);
          } else {
            socket.destroy();
          }
          continue;
        }
        const response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          ...(request.method === "initialize" ? { result: { clientId: "unknown-client" } }
            : request.method === "thread-owner-discovery" ? { handledByClientId: "desktop-owner" }
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const queue = new CodexDesktopQueue({ statePath, pipePath, onChanged: () => undefined });
  t.after(() => queue.dispose());
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", timeoutQueued.id, { requestId: "timeout-steer", content: timeoutQueued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "DELIVERY_UNKNOWN"
      && !error.retryable,
  );
  // The production owner persists every set-state request. This lightweight
  // IPC fixture records it, so mirror that persisted first removal before the
  // independent pipe-loss attempt reads native state again.
  await writeFile(statePath, JSON.stringify({ "queued-follow-ups": { thread: [pipeQueued] } }), "utf8");
  await assert.rejects(
    () => queue.steerQueuedMessage("thread", pipeQueued.id, { requestId: "pipe-loss-steer", content: pipeQueued.text }),
    (error: unknown) => error instanceof ProviderAdapterError
      && error.code === "DELIVERY_UNKNOWN"
      && !error.retryable,
  );

  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-steer-turn",
    "initialize",
    "thread-owner-discovery",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-steer-turn",
  ]);
  assert.deepEqual(queueStates, [
    { thread: [pipeQueued] },
    {},
  ], "ambiguous native steers must not restore their retryable queue rows");
  assert.deepEqual(queue.list(), [], "the consumed native queue state must remain consumed until authoritative reconciliation");
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
