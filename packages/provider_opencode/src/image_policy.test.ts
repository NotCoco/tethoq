import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCodeImagePolicy } from "./image_policy.js";
import { OpenCodeHttpClient } from "./http_client.js";

for (const scenario of ["already ready", "idle reload", "busy", "missing plugin"] as const) {
  test(`image policy activation: ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "tethoq-image-activation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = resolve(root);
    const pluginSourcePath = join(root, "policy.mjs");
    await writeFile(pluginSourcePath, "test-plugin");
    const revision = createHash("sha256").update("test-plugin").digest("hex");
    const key = createHash("sha256").update(`41000\n${process.platform === "win32" ? directory.toLowerCase() : directory}`).digest("hex");
    const ready = () => writeFile(join(root, `ready-${key}.json`), JSON.stringify({ version: 1, revision, pid: process.pid }));
    if (scenario === "already ready") await ready();
    const calls: string[] = [];
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:41000", fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path === "/instance/dispose" && scenario === "idle reload") await ready();
      return new Response(JSON.stringify(path === "/session/status" && scenario === "busy" ? { running: { type: "busy" } } : {}));
    } });
    const policy = new OpenCodeImagePolicy({ stateRoot: root, pluginSourcePath });
    if (scenario === "busy" || scenario === "missing plugin") {
      await assert.rejects(policy.prepare(client, "session", directory), { code: scenario === "busy" ? "IMAGE_POLICY_PENDING" : "IMAGE_POLICY_UNAVAILABLE" });
      if (scenario === "busy") assert.ok(!calls.some(call => call.includes("dispose")), "never dispose a workspace with live work");
    } else {
      await policy.prepare(client, "session", directory);
      const registry = join(root, `${createHash("sha256").update("session").digest("hex")}.json`);
      assert.equal(JSON.parse(await readFile(registry, "utf8")).sessionID, "session");
      assert.equal(calls.filter(call => call.includes("dispose")).length, scenario === "idle reload" ? 1 : 0);
    }
  });
}

test("cached history displays owned images without extending their expiry or opening other local files", async t => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-image-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheRoot = join(root, "cache");
  await mkdir(cacheRoot);
  const path = join(cacheRoot, "image.png");
  await writeFile(path, Buffer.from([1, 2, 3]));
  const file = () => ({ type: "file", mime: "image/png", filename: "image.png", url: pathToFileURL(path).href, text: undefined as string | undefined });
  const policy = new OpenCodeImagePolicy({ cacheRoot });
  const rows = [{ parts: [file()] }];
  await policy.hydrateHistory(rows);
  assert.equal(rows[0]!.parts[0]!.url, "data:image/png;base64,AQID");
  assert.equal(policy.isCachedImage(pathToFileURL(join(root, "private.png")).href), false);
  assert.equal(policy.isCachedImage("file:///broken%"), false);
  await rm(path);
  const expired = [{ parts: [file()] }];
  await policy.hydrateHistory(expired);
  assert.equal(expired[0]!.parts[0]!.type, "text");
  assert.match(expired[0]!.parts[0]!.text!, /expired/);
});
