import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { installOpenCodeMeshTools, openCodeMeshToolPath } from "./opencode_tools.js";
import { installPiTools, piToolExtensionPath } from "./pi_tools.js";

async function fixture(t: TestContext, provider: "opencode" | "pi", recoveryMs = 600, fileModule = false) {
  const root = await mkdtemp(join(tmpdir(), "tethoq-tool-transport-"));
  const directory = join(root, "runtimes");
  await mkdir(directory);
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  await (provider === "opencode" ? installOpenCodeMeshTools : installPiTools)({ userHome: root });
  const source = await readFile((provider === "opencode" ? openCodeMeshToolPath : piToolExtensionPath)(root), "utf8");
  const executable = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace(/import \{ Type \} from "typebox"\r?\n/u, "")
    .replace("const configuredRuntimePath = process.env.UAR_MESH_RUNTIME", `const configuredRuntimePath = ${JSON.stringify(join(root, "configured.json"))}`)
    .replace('const legacyRuntimePath = join(homedir(), ".tethoq", "mesh-tool-runtime.json")', `const legacyRuntimePath = ${JSON.stringify(join(root, "legacy.json"))}`)
    .replace('const runtimeDirectory = join(homedir(), ".tethoq", "mesh-runtimes")', `const runtimeDirectory = ${JSON.stringify(directory)}`)
    .replace("const runtimeResponseTimeoutMs = 2_000", "const runtimeResponseTimeoutMs = 25")
    .replace("const runtimeActiveTimeoutMs = 30_000", "const runtimeActiveTimeoutMs = 120")
    .replace("const runtimeRecoveryTimeoutMs = 30_000", `const runtimeRecoveryTimeoutMs = ${recoveryMs}`)
    .replace("setTimeout(resolve, 250)", "setTimeout(resolve, 10)")
    .replace(/export const list_children[\s\S]*$|export default function tethoqTools[\s\S]*$/u, "export { call }\n");
  const modulePath = join(root, "tools.mjs");
  if (fileModule) await writeFile(modulePath, executable);
  const module = await import(fileModule ? pathToFileURL(modulePath).href : `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}#${randomUUID()}`) as {
    call: (session: string, tool: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  const runtime = async (name: string, onRequest: (socket: Socket) => void) => {
    const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\transport-${randomUUID()}` : join(root, `${name}.sock`);
    const sockets = new Set<Socket>();
    let calls = 0;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => { calls++; onRequest(socket); });
    });
    await new Promise<void>(done => server.listen(pipePath, done));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
    const path = join(directory, name + ".json");
    const publish = () => writeFile(path, JSON.stringify({ hostId: name, pipePath, token: "fixture", startedAt: name }));
    return { publish, path, calls: () => calls, sockets };
  };
  return { call: async (tool: string, input = {}) => {
    const result = await module.call("fixture-session", tool, input);
    return typeof result === "string" ? JSON.parse(result) : result;
  }, runtime, update: (transform: (source: string) => string) => writeFile(modulePath, transform(executable)) };
}

test("an already loaded OpenCode helper uses an updated transport on its next call", async t => {
  const f = await fixture(t, "opencode", 120, true);
  let delayed = false;
  const live = await f.runtime("live", socket => {
    if (!delayed) { socket.end('{"ok":true,"result":{"ready":true}}\n'); return; }
    const timer = setTimeout(() => socket.end('{"ok":true,"result":{"timedOut":true,"children":[{"state":"working"}]}}\n'), 180);
    socket.once("close", () => clearTimeout(timer));
  });
  await live.publish();
  assert.deepEqual(await f.call("mesh_list_children"), { ready: true });
  await f.update(source => source.replace("const runtimeResponseTimeoutMs = 25", "const runtimeResponseTimeoutMs = 1000"));
  delayed = true;
  assert.deepEqual(await f.call("mesh_wait", { timeout_seconds: 300 }), { timedOut: true, children: [{ state: "working" }] });
  assert.equal(live.calls(), 2, "updating a helper must not replay an instruction");
});

test("a reloaded OpenCode helper preserves genuine task ownership errors", async t => {
  const f = await fixture(t, "opencode", 120, true);
  const runtime = await f.runtime("live", socket => socket.end('{"ok":false,"code":"TASK_NOT_OWNED_HERE","error":"This runtime does not own the parent task"}\n'));
  await runtime.publish();
  await assert.rejects(f.call("mesh_wait", { timeout_seconds: 300 }),
    (error: unknown) => (error as { code?: string }).code === "TASK_NOT_OWNED_HERE");
  assert.equal(runtime.calls(), 1);
});

for (const provider of ["opencode", "pi"] as const) {
  test(`${provider} recovers a read after a truncated connection without deleting a live descriptor`, async t => {
    const f = await fixture(t, provider);
    const broken = await f.runtime("z-broken", socket => socket.end(' {"ok":'));
    const live = await f.runtime("a-live", socket => socket.end(JSON.stringify({ ok: true, result: { children: ["one"] } }) + "\n"));
    await broken.publish(); await live.publish();
    assert.deepEqual(await f.call("mesh_read_result", { child_session_id: "one" }), { children: ["one"] });
    assert.equal(broken.calls(), 1);
    assert.equal(live.calls(), 1);
    assert.ok(await readFile(broken.path, "utf8"), "a transport break is not proof that the runtime is dead");
  });

  test(`${provider} does not replay a worker instruction after an uncertain acknowledgement`, async t => {
    const f = await fixture(t, provider);
    const accepted = await f.runtime("z-accepted", socket => { socket.write(" "); socket.destroy(); });
    const other = await f.runtime("a-other", socket => socket.end('{"ok":true,"result":{}}\n'));
    await accepted.publish(); await other.publish();
    await assert.rejects(f.call("mesh_message_child", { child_session_id: "one", message: "Do this once" }),
      (error: unknown) => (error as { code?: string }).code === "TOOL_DELIVERY_UNKNOWN");
    assert.equal(accepted.calls(), 1);
    assert.equal(other.calls(), 0, "a lost acknowledgement must not send another instruction elsewhere");
    assert.ok(await readFile(accepted.path, "utf8"));
  });

  test(`${provider} waits across a short runtime replacement and tolerates slow accepted work`, async t => {
    const f = await fixture(t, provider);
    const live = await f.runtime("live", socket => {
      socket.write(" ");
      const heartbeat = setInterval(() => socket.write(" "), 25);
      const timer = setTimeout(() => { clearInterval(heartbeat); socket.end('{"ok":true,"result":{"ready":true}}\n'); }, 180);
      socket.once("close", () => { clearInterval(heartbeat); clearTimeout(timer); });
    });
    const request = f.call("mesh_wait", { timeout_seconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    await live.publish();
    assert.deepEqual(await request, { ready: true });
    assert.equal(live.calls(), 1);
    assert.ok(await readFile(live.path, "utf8"));
  });

  test(`${provider} a silent accepted mutation times out without pruning or fallback`, async t => {
    const f = await fixture(t, provider);
    const silent = await f.runtime("z-silent", () => undefined);
    const other = await f.runtime("a-other", socket => socket.end('{"ok":true,"result":{}}\n'));
    await silent.publish(); await other.publish();
    await assert.rejects(f.call("browser_open", { url_or_search: "https://example.test" }),
      (error: unknown) => (error as { code?: string }).code === "TOOL_DELIVERY_UNKNOWN");
    assert.equal(silent.calls(), 1);
    assert.equal(other.calls(), 0);
    assert.ok(await readFile(silent.path, "utf8"));
  });

  test(`${provider} a wait interrupted late still gets time to reconnect`, { timeout: 5_000 }, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
    const f = await fixture(t, provider, 120);
    const replacement = await f.runtime("a-replacement", socket => socket.end('{"ok":true,"result":{"recovered":true}}\n'));
    let acceptOriginal!: (socket: Socket) => void;
    const accepted = new Promise<Socket>(resolve => { acceptOriginal = resolve; });
    const original = await f.runtime("z-original", socket => {
      socket.write(" ");
      acceptOriginal(socket);
    });
    await original.publish();
    const request = f.call("mesh_wait", { timeout_seconds: 1 });
    const socket = await accepted;
    await replacement.publish();
    // Accepted work can outlast the reconnect budget; the budget starts at the break.
    t.mock.timers.tick(200);
    socket.destroy();
    assert.deepEqual(await request, { recovered: true });
    assert.equal(original.calls(), 1);
    assert.equal(replacement.calls(), 1);
  });
}
