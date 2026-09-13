import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "tethoq-session-cache-"));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = join(directory, "cache.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/renderer/src/recent_session_cache.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { RecentSessionCache } = await import(pathToFileURL(outfile).href);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const policy = { maxEntries: 3, maxBytes: 100_000, freshMs: 100, idleMs: 1000, concurrency: 2 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("selection preloads once for both panels and refreshes without blanking names", async () => {
  let now = 0;
  let gate = deferred();
  let reads = 0;
  const cache = new RecentSessionCache(() => { reads += 1; return gate.promise; }, { ...policy, now: () => now });
  const release = cache.retain("parent");
  const preload = cache.load("parent");
  assert.equal(cache.load("parent"), preload);
  gate.resolve([{ title: "Worker name" }]);
  await preload;
  await cache.load("parent");
  assert.equal(reads, 1);
  now = 200;
  gate = deferred();
  const refresh = cache.load("parent");
  assert.equal(cache.getSnapshot("parent").data[0].title, "Worker name");
  assert.equal(cache.getSnapshot("parent").loading, true);
  gate.resolve([{ title: "Renamed worker" }]);
  await refresh;
  assert.equal(cache.getSnapshot("parent").data[0].title, "Renamed worker");
  release();
});

test("recent tasks use LRU eviction and expire while the current task stays warm", async () => {
  let now = 0;
  const cache = new RecentSessionCache(async (id) => [id], { ...policy, now: () => now });
  const release = cache.retain("current");
  await cache.load("current");
  await cache.load("old");
  await cache.load("recent");
  await cache.load("another");
  assert.equal(cache.getSnapshot("old").data, undefined);
  assert.deepEqual(cache.getSnapshot("current").data, ["current"]);
  now = 1200;
  cache.sweep();
  assert.equal(cache.getSnapshot("recent").data, undefined);
  assert.equal(cache.getSnapshot("another").data, undefined);
  assert.deepEqual(cache.getSnapshot("current").data, ["current"]);
  release();
  now += 1001;
  cache.sweep();
  assert.equal(cache.getSnapshot("current").data, undefined);
});

test("metadata has a byte budget and oversized visible lists are released on close", async () => {
  const cache = new RecentSessionCache(async () => "x".repeat(80), { ...policy, maxBytes: 200 });
  await cache.load("old");
  await cache.load("new");
  assert.equal(cache.getSnapshot("old").data, undefined);
  assert.equal(cache.getSnapshot("new").data.length, 80);
  const large = new RecentSessionCache(async () => "x".repeat(200), { ...policy, maxBytes: 200 });
  const release = large.retain("visible");
  await large.load("visible");
  assert.equal(large.getSnapshot("visible").data.length, 200);
  release();
  assert.equal(large.getSnapshot("visible").data, undefined);
});

test("rapid navigation bounds concurrent reads and drops old queued tasks", async () => {
  const reads = [];
  const gates = new Map();
  const cache = new RecentSessionCache((id) => {
    reads.push(id);
    const gate = deferred();
    gates.set(id, gate);
    return gate.promise;
  }, policy);
  const promises = [];
  for (let id = 0; id < 12; id += 1) promises.push(cache.load(String(id)).catch(() => undefined));
  assert.deepEqual(reads, ["0", "1"]);
  gates.get("0").resolve(["old"]);
  await tick();
  assert.deepEqual(reads, ["0", "1", "11"]);
  assert.equal(cache.getSnapshot("0").data, undefined, "late reads cannot resurrect evicted tasks");
  gates.get("1").resolve([]);
  await tick();
  assert.deepEqual(reads, ["0", "1", "11", "10"]);
  gates.get("11").resolve([]);
  await tick();
  gates.get("10").resolve([]);
  await tick();
  gates.get("9").resolve([]);
  await Promise.all(promises);
  assert.deepEqual(reads, ["0", "1", "11", "10", "9"]);
});

test("live invalidation rejects late stale data and coalesces its replacement", async () => {
  const gates = [deferred(), deferred()];
  let reads = 0;
  const cache = new RecentSessionCache(() => gates[reads++].promise, policy);
  const first = cache.load("parent");
  cache.invalidate("parent");
  assert.equal(cache.load("parent"), first);
  gates[0].resolve(["stale"]);
  await tick();
  assert.equal(cache.getSnapshot("parent").data, undefined);
  assert.equal(reads, 2);
  gates[1].resolve(["current"]);
  assert.deepEqual(await first, ["current"]);
  assert.deepEqual(cache.getSnapshot("parent").data, ["current"]);
});

test("refresh failure keeps names, permits retry, and disposed listeners stay removed", async () => {
  let fail = false;
  const cache = new RecentSessionCache(async () => {
    if (fail) throw new Error("offline");
    return ["worker"];
  }, policy);
  let changes = 0;
  const unsubscribe = cache.subscribe("parent", () => { changes += 1; });
  await cache.load("parent");
  fail = true;
  await assert.rejects(cache.load("parent", true), /offline/u);
  assert.deepEqual(cache.getSnapshot("parent").data, ["worker"]);
  assert.equal(cache.getSnapshot("parent").loading, false);
  unsubscribe();
  const before = changes;
  fail = false;
  await cache.load("parent", true);
  cache.clear();
  assert.equal(changes, before);
  assert.equal(cache.getSnapshot("parent").data, undefined);
});

test("clearing the cache during a request cannot restore data after unmount", async () => {
  const gate = deferred();
  const cache = new RecentSessionCache(() => gate.promise, policy);
  const request = cache.load("parent");
  cache.clear();
  gate.resolve(["late"]);
  await request;
  assert.equal(cache.getSnapshot("parent").data, undefined);
});
