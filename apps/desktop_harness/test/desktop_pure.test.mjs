import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const outputDirectory = join(tmpdir(), `tethoq-desktop-pure-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });

async function bundle(entry, name) {
  const outfile = join(outputDirectory, `${name}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  return await import(`file:///${outfile.replaceAll("\\", "/")}`);
}

const windowState = await bundle("../src/main/window_state.ts", "window-state");
const openCode = await bundle("../src/main/opencode_supervisor.ts", "opencode-supervisor");
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("window state defaults and clamps unsafe dimensions", () => {
  assert.equal(windowState.parseWindowState(null), windowState.DEFAULT_WINDOW_STATE);
  assert.deepEqual(windowState.parseWindowState({ width: 100, height: 9_999, x: 24, y: -12, maximized: true }), {
    width: 760,
    height: 4_320,
    x: 24,
    y: -12,
    maximized: true,
  });
  assert.deepEqual(windowState.parseWindowState({ width: 1_440, height: 900, maximized: false }), {
    width: 1_440,
    height: 900,
    maximized: false,
  });
});

test("OpenCode supervisor only manages the fixed local endpoint", () => {
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4096/")), true);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://localhost:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("https://127.0.0.1:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:9000/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://10.0.0.2:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4096/custom")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://user:pass@127.0.0.1:4096/")), false);
});

test("OpenCode recognizes a healthy externally managed server without spawning", async () => {
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => new Response(null, { status: 200 }),
    spawnProcess: () => {
      spawned = true;
      throw new Error("spawn should not run");
    },
  });

  assert.deepEqual(await supervisor.ensureRunning(), {
    state: "external",
    url: "http://127.0.0.1:4096/",
    managed: false,
  });
  assert.equal(spawned, false);
});

test("OpenCode refuses to supervise a remote or custom endpoint", async () => {
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    url: "http://example.test:4096/",
    fetchHealth: async () => { throw new Error("offline"); },
    spawnProcess: () => {
      spawned = true;
      throw new Error("spawn should not run");
    },
  });

  const status = await supervisor.ensureRunning();
  assert.equal(status.state, "unavailable");
  assert.equal(status.managed, false);
  assert.match(status.message, /Only the local OpenCode endpoint/);
  assert.equal(spawned, false);
});

test("OpenCode disposal waits for an in-flight managed start", async () => {
  let resolveHealth;
  let healthChecks = 0;
  let killed = false;
  const child = {
    pid: undefined,
    exitCode: null,
    killed: false,
    stderr: undefined,
    once() { return this; },
    kill() { killed = true; this.killed = true; return true; },
  };
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => {
      healthChecks += 1;
      if (healthChecks === 1) return new Response(null, { status: 503 });
      return await new Promise((resolve) => { resolveHealth = resolve; });
    },
    spawnProcess: () => child,
  });

  const starting = supervisor.ensureRunning();
  while (resolveHealth === undefined) await new Promise((resolve) => setImmediate(resolve));
  const disposal = supervisor.dispose();
  resolveHealth(new Response(null, { status: 200 }));
  await Promise.all([starting, disposal]);

  assert.equal(killed, true);
  assert.equal(supervisor.status().state, "stopped");
});
