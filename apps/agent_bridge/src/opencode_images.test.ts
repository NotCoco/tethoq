import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installOpenCodeImagePolicy } from "./opencode_tools.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hour = 3_600_000;
// Native plugin hooks operate on OpenCode's own JSON message objects.
type Row = { info: Record<string, any>; parts: Record<string, any>[] };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tethoq-image-policy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installOpenCodeImagePolicy({ userHome: root });
  const source = await readFile(join(root, ".config/opencode/tethoq_images.mjs"), "utf8");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const stateRoot = join(root, "state");
  const cacheRoot = join(root, "cache");
  await mkdir(stateRoot);
  let clock = Date.now();
  const stored = new Map<string, any>();
  const options = { stateRoot, cacheRoot, revision: hash(source), now: () => clock };
  const input = { directory: root, serverUrl: new URL("http://127.0.0.1:41000"), client: { _client: {
    patch: async ({ body }: { body: any }) => { stored.set(body.id, structuredClone(body)); return {}; },
  } } };
  const hooks = await loaded.default(input, options);
  t.after(() => hooks.dispose());
  async function register(id = "session") {
    await writeFile(join(stateRoot, `${hash(id)}.json`), JSON.stringify({ version: 1, sessionID: id, lastActivity: clock }));
  }
  const image = (id: string, messageID = "current", sessionID = "session") => ({ id, messageID, sessionID,
    type: "file", mime: "image/png", filename: "screenshot.png", url: "data:image/png;base64,AQID" });
  const row = (id: string, parts: any[], role = "user"): Row => ({ info: { id, role, sessionID: "session", ...(role === "assistant" ? { parentID: "current" } : {}) }, parts });
  const transform = async (messages: Row[]) => {
    const output = { messages: structuredClone(messages) };
    await hooks["experimental.chat.messages.transform"]({}, output);
    return output.messages;
  };
  return { root, stateRoot, cacheRoot, hooks, loaded, input, options, stored, register, image, row, transform,
    advance: (ms: number) => { clock += ms; } };
}

test("image policy sends only the current user turn, keeps named files, and leaves unrelated sessions alone", async t => {
  const f = await fixture(t);
  const history = [f.row("old", Array.from({ length: 35 }, (_, i) => f.image(`old-${i}`, "old"))), f.row("current", [f.image("new")])];
  assert.deepEqual(await f.transform(history), history);
  await f.register();
  await f.hooks["chat.message"]({ sessionID: "session" }, { message: { id: "current" } });
  const output = await f.transform(history);
  assert.ok(output[0]!.parts.every(part => part.type === "text" && part.text.includes("screenshot")));
  assert.match(output[1]!.parts[0]!.url, /^data:image/);
  assert.equal(f.stored.size, 36);
  assert.ok([...f.stored.values()].every(part => part.url.startsWith("file:")));
  assert.equal((await readdir(join(f.cacheRoot, hash("session")))).length, 36);
  const repeated = await f.transform([f.row("current", [f.stored.get("new")])]);
  assert.match(repeated[0]!.parts[0]!.url, /^data:image/, "current-turn user images remain visible during that turn");
  await f.hooks["chat.message"]({ sessionID: "session" }, { message: { id: "text-only" } });
  assert.equal((await f.transform(history))[1]!.parts[0]!.type, "text");
});

test("screenshots stay local; explicit image reads are shown once and other attachments survive", async t => {
  const f = await fixture(t);
  await f.register();
  await f.hooks["chat.message"]({ sessionID: "session" }, { message: { id: "current" } });
  const tool = (id: string, name: string) => ({ id, sessionID: "session", messageID: "assistant", type: "tool", tool: name,
    state: { status: "completed", output: "done", metadata: {}, attachments: [f.image(`image-${id}`), { type: "file", mime: "text/plain", url: "data:text/plain;base64,YQ==" }] } });
  const first = await f.transform([f.row("assistant", [tool("capture", "browser_screenshot"), tool("view", "read")], "assistant")]);
  assert.equal(first[0]!.parts[0]!.state.attachments.length, 1);
  assert.equal(first[0]!.parts[1]!.state.attachments.length, 2);
  assert.match(first[0]!.parts[0]!.state.output, /screenshot.*Use read/s);
  const next = await f.transform([f.row("assistant", [f.stored.get("capture"), f.stored.get("view")], "assistant")]);
  assert.ok(next[0]!.parts.every(part => part.state.attachments.every((file: any) => file.mime === "text/plain")));
});

test("cache expires at one hour, survives restart until then, and preserves original files", async t => {
  const f = await fixture(t);
  await f.register();
  await f.hooks["chat.message"]({ sessionID: "session" }, { message: { id: "current" } });
  const original = join(f.root, "original.png");
  await writeFile(original, Buffer.from([1, 2, 3]));
  await f.transform([f.row("current", [{ ...f.image("external"), url: pathToFileURL(original).href }])]);
  const cached = f.stored.get("external");
  f.advance(hour - 1);
  let restarted = await f.loaded.default(f.input, f.options);
  await restarted.dispose();
  assert.deepEqual(await readFile(fileURLToPath(cached.url)), Buffer.from([1, 2, 3]));
  f.advance(1);
  restarted = await f.loaded.default(f.input, f.options);
  await restarted.dispose();
  await assert.rejects(readFile(fileURLToPath(cached.url)), { code: "ENOENT" });
  assert.deepEqual(await readFile(original), Buffer.from([1, 2, 3]));
  const expired = await f.transform([f.row("current", [cached])]);
  assert.equal(expired[0]!.parts[0]!.type, "text");
  await assert.rejects(readFile(fileURLToPath(cached.url)), { code: "ENOENT" });
});

test("text progress renews inactivity, while unrelated events do not", async t => {
  const f = await fixture(t);
  await f.register();
  f.advance(hour - 1);
  await f.hooks.event({ event: { type: "message.part.delta", properties: { sessionID: "session" } } });
  const path = join(f.stateRoot, `${hash("session")}.json`);
  const active = JSON.parse(await readFile(path, "utf8")).lastActivity;
  f.advance(1000);
  await f.hooks.event({ event: { type: "server.heartbeat", properties: { sessionID: "session" } } });
  assert.equal(JSON.parse(await readFile(path, "utf8")).lastActivity, active);
});

test("native persistence errors stop the request instead of replaying unsanitized images", async t => {
  const f = await fixture(t);
  await f.register();
  f.input.client._client.patch = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(f.transform([f.row("old", [f.image("old", "old")])]), /disk unavailable/);
});

test("idle archival covers paginated compacted history and screenshots from a stopped turn", async t => {
  const f = await fixture(t);
  await f.register();
  const tool = { id: "stopped-tool", sessionID: "session", messageID: "assistant", type: "tool", tool: "browser_screenshot",
    state: { status: "completed", output: "captured", metadata: {}, attachments: [f.image("capture")] } };
  const cursors: unknown[] = [];
  (f.input.client._client as any).get = async ({ query }: any) => {
    cursors.push(query.before);
    return { data: query.before ? [f.row("old", [f.image("old", "old")])] : [f.row("assistant", [tool], "assistant")],
      response: { headers: new Headers(query.before ? {} : { "x-next-cursor": "page-two" }) } };
  };
  await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: "session" } } });
  assert.deepEqual(cursors, [undefined, "page-two"]);
  assert.match(f.stored.get("old").url, /^file:/);
  assert.match(f.stored.get("stopped-tool").state.attachments[0].url, /^file:/);
  assert.equal(f.stored.get("stopped-tool").state.metadata.tethoqImagesViewed, undefined);
});

test("a busy runner retains its inputs; idle expiry resumes after work ends", async t => {
  const f = await fixture(t);
  await f.register();
  await f.transform([f.row("old", [f.image("old", "old")])]);
  const cached = f.stored.get("old");
  await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } } });
  f.advance(hour);
  let restarted = await f.loaded.default(f.input, f.options);
  await restarted.dispose();
  assert.ok(await readFile(fileURLToPath(cached.url)));
  await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } } });
  await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: "session" } } });
  f.advance(hour);
  restarted = await f.loaded.default(f.input, f.options);
  await restarted.dispose();
  await assert.rejects(readFile(fileURLToPath(cached.url)), { code: "ENOENT" });
});

test("branch image copies have independent cache lifetimes and cannot delete each other's files", async t => {
  const f = await fixture(t);
  await f.register();
  await f.transform([f.row("old", [f.image("source", "old")])]);
  const source = f.stored.get("source");
  await f.register("branch");
  f.advance(hour / 2);
  const row = { info: { id: "branch-user", role: "user", sessionID: "branch" },
    parts: [{ ...source, id: "copy", sessionID: "branch", messageID: "branch-user" }] };
  await f.transform([row]);
  const copy = f.stored.get("copy");
  assert.notEqual(copy.url, source.url);
  f.advance(hour / 2);
  const restarted = await f.loaded.default(f.input, f.options);
  await restarted.dispose();
  await assert.rejects(readFile(fileURLToPath(source.url)), { code: "ENOENT" });
  assert.ok(await readFile(fileURLToPath(copy.url)));
});

test("native forks register from copied cache references without parentID and keep new images visible", async t => {
  const f = await fixture(t);
  await f.register();
  await f.transform([f.row("old", [f.image("source", "old")])]);
  const source = f.stored.get("source");
  await f.hooks["chat.message"]({ sessionID: "fork" }, { message: { id: "new" } });
  const copied = { ...source, id: "copied", sessionID: "fork", messageID: "old-copy" };
  const tool = { id: "tool-copy", sessionID: "fork", messageID: "assistant-copy", type: "tool", tool: "read",
    state: { status: "completed", output: "old screenshot", metadata: {}, attachments: [source] } };
  const output = await f.transform([
    { info: { id: "old-copy", role: "user", sessionID: "fork" }, parts: [copied] },
    { info: { id: "assistant-copy", role: "assistant", sessionID: "fork", parentID: "old-copy" }, parts: [tool] },
    { info: { id: "new", role: "user", sessionID: "fork" }, parts: [f.image("fresh", "new", "fork")] },
  ]);
  assert.equal(output[0]!.parts[0]!.type, "text");
  assert.equal(output[1]!.parts[0]!.state.attachments.length, 0);
  assert.match(output[2]!.parts[0]!.url, /^data:image/);
  const state = JSON.parse(await readFile(join(f.stateRoot, `${hash("fork")}.json`), "utf8"));
  assert.equal(state.currentUserMessageID, "new");
  assert.notEqual(f.stored.get("copied").url, source.url);
  assert.deepEqual(await readFile(fileURLToPath(source.url)), Buffer.from([1, 2, 3]));
});

test("already-broken forks recover expired user and tool images after a restart", async t => {
  const f = await fixture(t);
  const expired = { ...f.image("expired", "old", "fork"),
    url: pathToFileURL(join(f.cacheRoot, hash("original"), "expired.png")).href };
  const output = await f.transform([
    { info: { id: "old", role: "user", sessionID: "fork" }, parts: [expired] },
    { info: { id: "tool-message", role: "assistant", sessionID: "fork" }, parts: [
      { id: "tool", messageID: "tool-message", sessionID: "fork", type: "tool", tool: "read",
        state: { status: "completed", output: "old result", metadata: {}, attachments: [expired] } },
    ] },
  ]);
  assert.equal(output[0]!.parts[0]!.type, "text");
  assert.match(output[0]!.parts[0]!.text, /temporary image unavailable/);
  assert.equal(output[1]!.parts[0]!.state.attachments.length, 0);
  assert.match(output[1]!.parts[0]!.state.output, /temporary image unavailable/);
  assert.ok(await readFile(join(f.stateRoot, `${hash("fork")}.json`)));
  const copiedAgain = { ...f.stored.get("expired"), id: "expired-again", sessionID: "second-fork" };
  const second = await f.transform([{ info: { id: "old", role: "user", sessionID: "second-fork" }, parts: [copiedAgain] }]);
  assert.equal(second[0]!.parts[0]!.type, "text");
  assert.match(second[0]!.parts[0]!.text, /temporary image unavailable/);
});

test("unrelated local files and malformed URLs do not register a chat for image policy", async t => {
  const f = await fixture(t);
  for (const url of [pathToFileURL(join(f.root, "outside.png")).href,
    pathToFileURL(join(f.cacheRoot + "-other", "outside.png")).href, "file:///bad%ZZ.png"]) {
    const rows = [f.row("ordinary", [{ ...f.image("outside"), url }])];
    assert.deepEqual(await f.transform(rows), rows);
  }
  await assert.rejects(readFile(join(f.stateRoot, `${hash("session")}.json`)), { code: "ENOENT" });
});
