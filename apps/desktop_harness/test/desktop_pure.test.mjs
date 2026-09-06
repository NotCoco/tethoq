import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
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
const openCodeWatch = await bundle("../src/main/opencode_watch.ts", "opencode-watch");
const discovery = await bundle("../src/main/opencode_discovery.ts", "opencode-discovery");
const toastFeedback = await bundle("../src/renderer/src/toast_feedback.ts", "toast-feedback");
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("routine confirmations stay silent while errors remain visible", () => {
  assert.equal(toastFeedback.visibleToastFeedback("Pasted image attached"), null);
  assert.equal(toastFeedback.visibleToastFeedback("Settings saved", "normal"), null);
  assert.deepEqual(toastFeedback.visibleToastFeedback("Pasted images must be between 1 byte and 25 MiB.", "error"), {
    message: "Pasted images must be between 1 byte and 25 MiB.",
    tone: "error",
  });
});

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

test("restored window bounds stay on the visible work area", () => {
  assert.deepEqual(windowState.clampWindowStateToDisplay({
    width: 1391,
    height: 920,
    x: 8000,
    y: -400,
    maximized: false,
  }, { x: 0, y: 0, width: 1920, height: 1080 }), {
    width: 1391,
    height: 920,
    x: 529,
    y: 0,
    maximized: false,
  });
});

test("OpenCode supervisor only manages the bounded local fallback range", () => {
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4096/")), true);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4097/")), true);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4100/")), true);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4197/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://localhost:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("https://127.0.0.1:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:9000/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://10.0.0.2:4096/")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://127.0.0.1:4096/custom")), false);
  assert.equal(openCode.isSupervisableEndpoint(new URL("http://user:pass@127.0.0.1:4096/")), false);
});

test("OpenCode fallback skips an occupied 4097 and starts on a free owned endpoint", async () => {
  const { createServer } = await import("node:net");
  const occupied = createServer();
  let owns4097 = false;
  await new Promise((resolve, reject) => {
    occupied.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve();
      else reject(error);
    });
    occupied.listen({ host: "127.0.0.1", port: 4097, exclusive: true }, () => {
      owns4097 = true;
      resolve();
    });
  });

  try {
    const url = await openCode.findAvailableOpenCodeServerUrl({ startPort: 4097, endPort: 4196 });
    const selectedPort = Number(new URL(url).port);
    assert.ok(selectedPort > 4097, `expected a free port after occupied 4097, received ${selectedPort}`);
    let healthChecks = 0;
    let spawnArgs = [];
    const child = {
      pid: undefined,
      exitCode: null,
      killed: false,
      stderr: undefined,
      once() { return this; },
      kill() { this.killed = true; return true; },
    };
    const supervisor = new openCode.OpenCodeSupervisor({
      url,
      canBindPort: async () => true,
      fetchHealth: async () => new Response(null, { status: ++healthChecks === 1 ? 503 : 200 }),
      spawnProcess: (_command, args) => {
        spawnArgs = [...args];
        return child;
      },
    });

    const status = await supervisor.ensureRunning();
    assert.equal(status.state, "managed");
    assert.equal(status.url, url);
    assert.match(spawnArgs.join(" "), new RegExp(`--port ${selectedPort}`, "u"));
    await supervisor.dispose();
  } finally {
    if (owns4097) await new Promise((resolve) => occupied.close(resolve));
  }
});

test("OpenCode reports a stable port_in_use reason when its managed endpoint is occupied", async () => {
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    url: "http://127.0.0.1:4097/",
    fetchHealth: async () => new Response(null, { status: 503 }),
    canBindPort: async () => false,
    spawnProcess: () => {
      spawned = true;
      throw new Error("spawn should not run");
    },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "failed");
  assert.equal(status.managed, false);
  assert.equal(status.reason, "port_in_use");
  assert.match(status.message, /already in use/u);
  assert.equal(spawned, false);
});

test("OpenCode preserves port_in_use when the port is claimed after the bind probe", async () => {
  const bindError = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4097"), {
    code: "EADDRINUSE",
  });
  const supervisor = new openCode.OpenCodeSupervisor({
    url: "http://127.0.0.1:4097/",
    fetchHealth: async () => new Response(null, { status: 503 }),
    canBindPort: async () => true,
    spawnProcess: () => { throw bindError; },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "failed");
  assert.equal(status.reason, "port_in_use");
  assert.match(status.message, /already in use/u);
});

test("OpenCode classifies bind diagnostics emitted by a started child", async () => {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.killed = false;
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; return true; };
  const supervisor = new openCode.OpenCodeSupervisor({
    url: "http://127.0.0.1:4097/",
    fetchHealth: async () => new Response(null, { status: 503 }),
    canBindPort: async () => true,
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.end("listen EADDRINUSE: address already in use 127.0.0.1:4097");
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "failed");
  assert.equal(status.reason, "port_in_use");
  assert.match(status.message, /already in use/u);
});

test("OpenCode keeps its managed Windows server hidden without allocating a detached console", async () => {
  let healthChecks = 0;
  let spawnOptions;
  const child = {
    pid: undefined,
    exitCode: null,
    killed: false,
    stderr: undefined,
    once() { return this; },
    kill() { this.killed = true; return true; },
  };
  const supervisor = new openCode.OpenCodeSupervisor({
    canBindPort: async () => true,
    fetchHealth: async () => new Response(null, { status: ++healthChecks === 1 ? 503 : 200 }),
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });

  assert.equal((await supervisor.ensureRunning()).state, "managed");
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.detached, process.platform !== "win32");
  await supervisor.dispose();
});

test("OpenCode free-port selection excludes endpoints that already lost a bind race", async () => {
  const firstUrl = await openCode.findAvailableOpenCodeServerUrl();
  const firstPort = Number(new URL(firstUrl).port);
  const nextUrl = await openCode.findAvailableOpenCodeServerUrl({ excludedPorts: [firstPort] });

  assert.notEqual(nextUrl, firstUrl);
  assert.notEqual(Number(new URL(nextUrl).port), firstPort);
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

test("OpenCode keeps a confirmed external server through transient health misses and resets its grace", async () => {
  const healthStatuses = [200, 503, 503, 200, 503, 503, 503];
  let healthChecks = 0;
  let bindChecks = 0;
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => new Response(null, { status: healthStatuses[healthChecks++] ?? 503 }),
    canBindPort: async () => { bindChecks += 1; return false; },
    spawnProcess: () => { spawned = true; throw new Error("spawn should not run while the live endpoint owns its port"); },
  });

  assert.equal((await supervisor.ensureRunning()).state, "external");
  assert.equal((await supervisor.ensureRunning()).state, "external");
  assert.equal((await supervisor.ensureRunning()).state, "external");
  assert.equal(bindChecks, 0, "two missed watchdog probes must not expose a live endpoint to fallback");

  assert.equal((await supervisor.ensureRunning()).state, "external", "a healthy response must clear the failure count");
  assert.equal((await supervisor.ensureRunning()).state, "external");
  assert.equal((await supervisor.ensureRunning()).state, "external");
  assert.equal(bindChecks, 0, "the reset grace must cover a later transient pause too");

  const failed = await supervisor.ensureRunning();
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "port_in_use");
  assert.equal(bindChecks, 1, "confirmed repeated failure must retain the existing recovery path");
  assert.equal(spawned, false);
});

test("OpenCode explicit restart bypasses the running health grace", async () => {
  let healthy = true;
  let bindChecks = 0;
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => new Response(null, { status: healthy ? 200 : 503 }),
    canBindPort: async () => { bindChecks += 1; return false; },
    spawnProcess: () => { throw new Error("an occupied external endpoint must not spawn"); },
  });

  assert.equal((await supervisor.ensureRunning()).state, "external");
  healthy = false;
  const restarted = await supervisor.restart();

  assert.equal(restarted.state, "failed");
  assert.equal(restarted.reason, "port_in_use");
  assert.equal(bindChecks, 1, "Restart must attempt recovery immediately instead of consuming grace checks");
});

test("OpenCode gives a released managed runner the same transient health grace", async () => {
  const { readFile } = await import("node:fs/promises");
  const statePath = join(outputDirectory, `opencode-released-grace-${Date.now()}.json`);
  let healthChecks = 0;
  let spawnCount = 0;
  const child = {
    pid: 98,
    exitCode: null,
    killed: false,
    stderr: undefined,
    once() { return this; },
    unref() {},
    kill() { this.killed = true; return true; },
  };
  const supervisor = new openCode.OpenCodeSupervisor({
    statePath,
    canBindPort: async () => true,
    fetchHealth: async () => new Response(null, { status: ++healthChecks === 1 || healthChecks === 3 ? 503 : 200 }),
    spawnProcess: () => { spawnCount += 1; return child; },
  });

  assert.equal((await supervisor.ensureRunning()).state, "managed");
  await supervisor.release();
  assert.equal((await supervisor.ensureRunning()).state, "managed");
  assert.equal(spawnCount, 1, "a transient miss must not reclaim or duplicate the released runner");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, 98);
  await rm(statePath, { force: true });
});

test("OpenCode startup probe leaves an unavailable server stopped without spawning", async () => {
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => { throw new Error("offline"); },
    spawnProcess: () => {
      spawned = true;
      throw new Error("spawn should not run");
    },
  });

  assert.deepEqual(await supervisor.probe(), {
    state: "stopped",
    url: "http://127.0.0.1:4096/",
    managed: false,
  });
  assert.equal(spawned, false);
});

test("OpenCode health checks authenticate against a password-protected server", async () => {
  let sentAuthorization = false;
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    environment: {
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: ["secret", "token", "value"].join("-"),
    },
    fetchHealth: async (_url, init) => {
      const headers = init?.headers ?? {};
      const combined = typeof headers === "object" && !Array.isArray(headers)
        ? headers
        : {};
      sentAuthorization = combined.authorization === "Basic b3BlbmNvZGU6c2VjcmV0LXRva2VuLXZhbHVl"
        || combined.Authorization === "Basic b3BlbmNvZGU6c2VjcmV0LXRva2VuLXZhbHVl";
      return new Response(null, { status: sentAuthorization ? 200 : 401 });
    },
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
  assert.equal(sentAuthorization, true);
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
    canBindPort: async () => true,
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

test("a replacement Tethoq generation restores and prioritizes its retained OpenCode runner", async () => {
  const { readFile } = await import("node:fs/promises");
  const statePath = join(outputDirectory, `opencode-release-${Date.now()}.json`);
  let healthChecks = 0;
  let killed = false;
  let childUnref = false;
  let stderrUnref = false;
  const child = new EventEmitter();
  child.pid = 97;
  child.exitCode = null;
  child.killed = false;
  child.stderr = new PassThrough();
  child.stderr.unref = () => { stderrUnref = true; };
  child.unref = () => { childUnref = true; };
  child.kill = () => { killed = true; child.killed = true; return true; };
  const supervisor = new openCode.OpenCodeSupervisor({
    statePath,
    canBindPort: async () => true,
    fetchHealth: async () => new Response(null, { status: ++healthChecks === 1 ? 503 : 200 }),
    spawnProcess: () => child,
  });

  assert.equal((await supervisor.ensureRunning()).state, "managed");
  await supervisor.release();

  assert.equal(killed, false, "restarting the shell must not terminate the provider runner");
  assert.equal(childUnref, true);
  assert.equal(stderrUnref, true);
  assert.equal(supervisor.hasManagedChild, false, "the old Electron generation must release its process handle");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, 97, "the replacement generation needs the durable ownership record");

  let replacementSpawned = false;
  const replacement = new openCode.OpenCodeSupervisor({
    statePath,
    fetchHealth: async () => new Response(null, { status: 200 }),
    spawnProcess: () => { replacementSpawned = true; throw new Error("healthy runner must be reused"); },
  });
  const replacementStatus = await replacement.probe();
  assert.deepEqual(replacementStatus, {
    state: "managed",
    url: "http://127.0.0.1:4096/",
    managed: true,
    pid: 97,
  });
  assert.equal((await replacement.ensureRunning()).state, "managed");
  assert.equal(discovery.shouldDiscoverOpenCodeServer({
    envUrl: undefined,
    status: replacementStatus,
    hasManagedChild: replacement.hasManagedChild,
  }), false, "startup must not adopt a different sidecar over the retained live runner");
  assert.equal(replacementSpawned, false);
  child.stderr.destroy();
});

test("desktop startup probes retained OpenCode ownership before sidecar discovery", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  const startupStart = runtimeSource.indexOf("private async startOnce()");
  const startupEnd = runtimeSource.indexOf("const pairingStore", startupStart);
  const startup = runtimeSource.slice(startupStart, startupEnd);
  const probeAt = startup.indexOf("await this.#openCode.probe()");
  const discoveryAt = startup.indexOf("await discoverOpenCodeServerUrl()");

  assert.ok(probeAt >= 0, "startup must probe the endpoint recorded by the previous generation");
  assert.ok(discoveryAt > probeAt, "external discovery must run only after retained ownership is restored");
  assert.match(startup, /shouldDiscoverOpenCodeServer\(\{ envUrl, status: openCodeStatus, hasManagedChild: this\.#openCode\.hasManagedChild \}\)/u);

  const retained = { state: "managed", url: "http://127.0.0.1:4096/", managed: true, pid: 97 };
  assert.equal(discovery.shouldDiscoverOpenCodeServer({ envUrl: undefined, status: retained, hasManagedChild: false }), false);
  assert.equal(discovery.shouldDiscoverOpenCodeServer({ envUrl: undefined, status: retained, hasManagedChild: true }), true);
  assert.equal(discovery.shouldDiscoverOpenCodeServer({ envUrl: "http://127.0.0.1:9000/", status: retained, hasManagedChild: true }), false);
});

test("OpenCode reports a credential mismatch instead of racing another server for the port", async () => {
  let healthChecks = 0;
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    fetchHealth: async () => {
      healthChecks += 1;
      return new Response(null, { status: 401 });
    },
    spawnProcess: () => {
      spawned = true;
      throw new Error("spawn should not run");
    },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "unavailable");
  assert.equal(status.managed, false);
  assert.equal(status.reason, "credentials_required");
  assert.match(status.message, /requires credentials/);
  assert.match(status.message, /TETHOQ_OPENCODE_PASSWORD/);
  // A second server on a taken port would only fail to bind and then time out.
  assert.equal(spawned, false);
  // One probe per call: a repeat could re-enter a check that is still in flight.
  assert.equal(healthChecks, 1);
});

test("OpenCode never reclaims a managed pid recorded for another local endpoint", async () => {
  const { writeFile } = await import("node:fs/promises");
  const statePath = join(outputDirectory, `opencode-cross-port-${Date.now()}.json`);
  await writeFile(statePath, JSON.stringify({ pid: 424244, url: "http://127.0.0.1:4096/" }), "utf8");
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    url: "http://127.0.0.1:4097/",
    statePath,
    fetchHealth: async () => new Response(null, { status: 401 }),
    spawnProcess: () => { spawned = true; throw new Error("spawn should not run"); },
  });

  const status = await supervisor.ensureRunning();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "credentials_required");
  assert.equal(spawned, false);
});

test("a force-killed desktop reclaims the OpenCode server it had left holding the port", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const statePath = join(outputDirectory, `opencode-supervisor-${Date.now()}.json`);
  // The previous run recorded its managed process and never reached before-quit.
  await writeFile(statePath, JSON.stringify({ pid: 424242, url: "http://127.0.0.1:4096/" }), "utf8");
  const child = {
    pid: 99,
    exitCode: null,
    killed: false,
    stderr: undefined,
    once() { return this; },
    kill() { return true; },
  };
  let healthChecks = 0;
  const supervisor = new openCode.OpenCodeSupervisor({
    statePath,
    canBindPort: async () => true,
    fetchHealth: async () => {
      healthChecks += 1;
      // Nothing answers until the orphan has been cleared and a new server is up.
      return new Response(null, { status: healthChecks <= 1 ? 503 : 200 });
    },
    spawnProcess: () => child,
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "managed");
  assert.equal(status.pid, 99);
  // The new managed pid is recorded so the next run can reclaim this one too.
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, 99);

  await supervisor.dispose();
  await assert.rejects(() => readFile(statePath, "utf8"));
});

test("a degraded OpenCode server Tethoq started is reclaimed rather than reported as foreign", async () => {
  const { writeFile } = await import("node:fs/promises");
  const statePath = join(outputDirectory, `opencode-degraded-${Date.now()}.json`);
  await writeFile(statePath, JSON.stringify({ pid: 424243, url: "http://127.0.0.1:4096/" }), "utf8");
  const child = { pid: 77, exitCode: null, killed: false, stderr: undefined, once() { return this; }, kill() { return true; } };
  let healthChecks = 0;
  const supervisor = new openCode.OpenCodeSupervisor({
    statePath,
    canBindPort: async () => true,
    // An orphaned server that has gone stale answers 401 to everything.
    fetchHealth: async () => new Response(null, { status: ++healthChecks <= 1 ? 401 : 200 }),
    spawnProcess: () => child,
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "managed");
  assert.equal(status.pid, 77);
  await supervisor.dispose();
});

test("a foreign password-protected OpenCode server is reported, never reclaimed", async () => {
  const statePath = join(outputDirectory, `opencode-foreign-${Date.now()}.json`);
  let spawned = false;
  const supervisor = new openCode.OpenCodeSupervisor({
    statePath,
    fetchHealth: async () => new Response(null, { status: 401 }),
    spawnProcess: () => { spawned = true; throw new Error("spawn should not run"); },
  });

  const status = await supervisor.ensureRunning();

  assert.equal(status.state, "unavailable");
  assert.match(status.message, /requires credentials/);
  assert.equal(spawned, false);
});

const openCodeStatus = (state, managed = false) => ({ state, url: "http://127.0.0.1:4096/", managed });

test("OpenCode watchdog reconnects the bridge when a stopped server comes up", async () => {
  let connected = false;
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("managed", true),
    reconnect: async () => { reconnects += 1; connected = true; },
    connected: () => connected,
  });

  await watchdog.tick();
  assert.equal(reconnects, 1, "a running server with no live subscription must reconnect the bridge");

  await watchdog.tick();
  assert.equal(reconnects, 1, "an already subscribed provider must not be reconnected again");
});

test("OpenCode watchdog stays quiet while the provider keeps running", async () => {
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("external"),
    reconnect: async () => { reconnects += 1; },
    connected: () => true,
  });

  await watchdog.tick();

  assert.equal(reconnects, 0);
});

test("OpenCode watchdog resubscribes when a server dies and is restarted under the same status", async () => {
  // The status string reads "managed" before the death and after the restart, so
  // nothing about it changes. Only the dropped subscription reveals the outage,
  // and missing it would leave the provider running but unable to stream or send.
  let reconnects = 0;
  let connected = true;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("managed", true),
    reconnect: async () => { reconnects += 1; connected = true; },
    connected: () => connected,
  });

  await watchdog.tick();
  assert.equal(reconnects, 0, "a healthy subscribed provider needs nothing");

  connected = false;
  await watchdog.tick();
  assert.equal(reconnects, 1, "a dropped subscription must be restored even when the status never changed");
});

test("OpenCode watchdog does not reconnect while the server stays down", async () => {
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("failed"),
    reconnect: async () => { reconnects += 1; },
    connected: () => false,
  });

  await watchdog.tick();

  assert.equal(reconnects, 0);
});

test("OpenCode watchdog recovers a server that failed to start earlier", async () => {
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("external"),
    reconnect: async () => { reconnects += 1; },
    connected: () => false,
  });

  await watchdog.tick();

  assert.equal(reconnects, 1);
});

test("OpenCode watchdog leaves a credentialed foreign server alone", async () => {
  // ensureRunning reports "unavailable" without spawning; reconnecting on top of
  // that would only produce a second failure the user cannot act on.
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => openCodeStatus("unavailable"),
    reconnect: async () => { reconnects += 1; },
    connected: () => false,
  });

  await watchdog.tick();

  assert.equal(reconnects, 0);
});

test("OpenCode watchdog skips a tick while the user's restart is stopping the process", async () => {
  let ensured = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => {
      ensured += 1;
      return openCodeStatus("managed", true);
    },
    reconnect: async () => undefined,
    connected: () => false,
    stopping: () => true,
  });

  await watchdog.tick();

  assert.equal(ensured, 0, "a deliberate stop in flight must not be fought by the watchdog");
});

test("OpenCode watchdog ticks on its interval and never ticks after disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let state = "stopped";
  let connected = false;
  let reconnects = 0;
  const watchdog = new openCodeWatch.OpenCodeWatchdog({
    ensureRunning: async () => {
      state = "managed";
      return openCodeStatus(state, true);
    },
    reconnect: async () => { reconnects += 1; connected = true; },
    connected: () => connected,
    intervalMs: 15_000,
  });

  watchdog.start();
  t.mock.timers.tick(15_001);
  for (let attempt = 0; attempt < 50 && reconnects === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(reconnects, 1);

  watchdog.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(reconnects, 1, "a disposed watchdog must never tick again");
});

test("desktop scheduling opens its durable store and reconciles before Bridge startup", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  const startupStart = runtimeSource.indexOf("private async startOnce()");
  const startupEnd = runtimeSource.indexOf("private startOpenCodeInBackground", startupStart);
  assert.ok(startupStart >= 0 && startupEnd > startupStart, "desktop runtime startup source must remain discoverable");
  const startup = runtimeSource.slice(startupStart, startupEnd);

  assert.match(runtimeSource, /import \{ ScheduledTaskStore, defaultScheduledTaskStatePath \} from "\.\.\/\.\.\/\.\.\/agent_bridge\/src\/scheduled_task_store\.js"/u);
  assert.match(runtimeSource, /import \{ ScheduledTaskScheduler \} from "\.\.\/\.\.\/\.\.\/agent_bridge\/src\/scheduled_tasks\.js"/u);
  assert.match(startup, /const scheduledTaskStore = new ScheduledTaskStore\(defaultScheduledTaskStatePath\(this\.#configPath\)\)/u);

  const configureAt = startup.indexOf("bridge.configureScheduledTasks(await ScheduledTaskScheduler.open({");
  const bridgeStartAt = startup.indexOf("await bridge.start()");
  assert.ok(configureAt >= 0, "desktop startup must open and attach the durable scheduled-task scheduler");
  assert.ok(bridgeStartAt > configureAt, "overdue tasks must reconcile before Bridge startup is reported ready");
  assert.match(startup, /store: scheduledTaskStore,[\s\S]*?dispatch: async \(task\) => await bridge\.dispatchScheduledTask\(task\),[\s\S]*?onChange: async \(\{ reason, task, previousTargetSessionId \}\) =>[\s\S]*?bridge\.scheduledTaskChanged\(task, reason, previousTargetSessionId\),[\s\S]*?onError: \(error\) => console\.error\("Scheduled task reconciliation failed", error\)/u);

  const reconcile = runtimeSource.match(/public async reconcileScheduledTasks\(\): Promise<void> \{[\s\S]*?\n  \}/u)?.[0] ?? "";
  assert.match(reconcile, /await this\.start\(\)/u, "resume reconciliation must wait until the runtime is ready");
  assert.match(reconcile, /await this\.bridge\.reconcileScheduledTasks\(\)/u);
});

test("Electron resume reconciles wall-clock schedules without crashing the main process", async () => {
  const { readFile } = await import("node:fs/promises");
  const indexSource = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

  assert.match(indexSource, /import \{[\s\S]*?powerMonitor,[\s\S]*?\} from "electron"/u);
  assert.match(indexSource, /const harness = runtime;[\s\S]*?powerMonitor\.on\("resume", \(\) => \{[\s\S]*?void harness\.reconcileScheduledTasks\(\)\.catch\(\(error: unknown\) => \{[\s\S]*?console\.error\("Tethoq could not reconcile scheduled tasks after resume", error\);[\s\S]*?\}\);[\s\S]*?\}\);/u);
});

test("a second Tethoq launch can ask the running instance to quit cleanly", async () => {
  const { readFile } = await import("node:fs/promises");
  const indexSource = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  // The quit argument must route through the single-instance lock into app.quit
  // while explicitly preserving the provider runner for the replacement shell.
  assert.match(indexSource, /QUIT_INSTANCE_ARGUMENT\s*=\s*"--quit-other"/u);
  assert.match(indexSource, /STOP_MANAGED_OPENCODE_ARGUMENT\s*=\s*"--stop-managed-opencode"/u);
  assert.match(indexSource, /argv\.includes\(QUIT_INSTANCE_ARGUMENT\)[\s\S]{0,240}forceStopManagedOpenCode\s*=\s*argv\.includes\(STOP_MANAGED_OPENCODE_ARGUMENT\)[\s\S]{0,120}preserveOpenCodeForRestart\s*=\s*!forceStopManagedOpenCode[\s\S]{0,120}quitting\s*=\s*true/u);
  assert.match(indexSource, /runtime\?\.dispose\(\{[\s\S]{0,160}preserveOpenCode:\s*preserveOpenCodeForRestart,[\s\S]{0,120}forceStopOpenCode:\s*forceStopManagedOpenCode/u);
  assert.match(indexSource, /app\.quit\(\)/u);

  const stopSource = await readFile(new URL("../scripts/stop-unpacked.cjs", import.meta.url), "utf8");
  assert.match(stopSource, /taskkill\.exe", \["\/PID", String\(row\.ProcessId\), "\/F"\]/u);
  assert.doesNotMatch(stopSource, /String\(row\.ProcessId\), "\/T"/u, "forced shell replacement must not kill provider descendants");
  assert.match(stopSource, /return forceKill\(processRows\(\)\)/u,
    "the forced fallback must include a quit helper that inherited the single-instance lock");

  const appSource = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  // A quiet live feed must still heal the open task on a calm cadence, so a
  // broken subscription cannot freeze the transcript until a relaunch.
  assert.match(appSource, /selectedSessionLastDeltaAt\(lastLiveDeltaBySession\.current,\s*sessionId,\s*lastLiveDeltaAt\.current\)/u);
  assert.match(appSource, /sessionNeedsTranscriptCatchUp\(session, current\?\.timelines\[selected\] \?\? \[\], workingBoundaryBySession\.current\.get\(selected\)\)/u);
  assert.match(appSource, /refreshVisibleState\(false\)/u);
  assert.match(appSource, /\}, quietCatchUpIntervalMs\);/u);
  // Quietness must be decided by the selected session's own deltas. Using one
  // global signal let a busy unrelated task suppress the catch-up for the chat
  // the user was watching, which is exactly how a split session's newest
  // output stayed invisible even with the poll in place.
  assert.match(appSource, /lastLiveDeltaBySession\s*=\s*useRef\(new Map<string, number>\(\)\)/u);
  assert.match(appSource, /const liveTurnSessions = new Set\([\s\S]*isLiveTurnEvent\(event\)/u);
  assert.match(appSource, /for \(const sessionId of liveTurnSessions\) lastLiveDeltaBySession\.current\.set\(sessionId, now\)/u);
  assert.match(appSource, /for \(const sessionId of advancedLiveSessions\)[\s\S]*liveTimelineGenerationBySession\.current\.set\(sessionId,/u);
  assert.match(appSource, /quietCatchUpDue\(selectedLastDelta\(selected\)/u);

  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  assert.match(runtimeSource, /await this\.#bridge\?\.drainScheduledTasksForShutdown\(\)[\s\S]{0,500}const openCodeHasActiveWork[\s\S]{0,500}options\.forceStopOpenCode !== true[\s\S]{0,120}options\.preserveOpenCode === true \|\| openCodeHasActiveWork/u);
  assert.match(runtimeSource, /preserveOpenCode \? this\.#openCode\.release\(\) : this\.#openCode\.dispose\(\)/u);
  // The task list must keep itself fresh even when the live feed is quiet:
  // OpenCode is re-listed on a calm cadence (one cheap HTTP list, no provider
  // processes spawned) so titles, previews, and recency update without a click.
  assert.match(runtimeSource, /OPENCODE_RELIST_MS\s*=\s*15_000/u);
  assert.match(runtimeSource, /this\.reconnectOpenCodeProvider\(bridge\)\.catch/u);
});

test("OpenCode startup and recovery operations are single-flight", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  assert.match(runtimeSource, /#openCodeEnsurePromise: Promise<ReturnType<OpenCodeSupervisor\["status"\]>> \| undefined/u);
  assert.match(runtimeSource, /const inFlight = this\.#openCodeEnsurePromise;[\s\S]{0,180}if \(inFlight !== undefined\) return inFlight;/u);
  assert.match(runtimeSource, /#openCodeReconnectPromise: Promise<void> \| undefined/u);
  assert.match(runtimeSource, /const inFlight = this\.#openCodeReconnectPromise;[\s\S]{0,180}if \(inFlight !== undefined\) return inFlight;/u);
  assert.match(runtimeSource, /reconnect: \(\) => this\.reconnectOpenCodeProvider\(bridge\)/u);
});

test("Codex detection keeps its transient version probe hidden on Windows", async () => {
  const { readFile } = await import("node:fs/promises");
  const commandSource = await readFile(new URL("../../../packages/provider_codex/src/codex_command.ts", import.meta.url), "utf8");
  assert.match(commandSource, /execFile\(launch\.command, \[\.\.\.launch\.args\], \{[\s\S]*?timeout: 5_000,[\s\S]*?windowsHide: true,/u);
});

test("the desktop keeps its own server alive as a secondary feed while a turn it started is still in flight", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  const supervisorSource = await readFile(new URL("../src/main/opencode_supervisor.ts", import.meta.url), "utf8");
  const adapterSource = await readFile(new URL("../../../packages/provider_opencode/src/opencode_adapter.ts", import.meta.url), "utf8");
  // Handing over to the user's OpenCode must never kill a turn we are running:
  // the old server is kept as the provider's secondary feed until it drains.
  assert.match(runtimeSource, /#retiredOpenCode: OpenCodeSupervisor \| undefined/u);
  assert.match(runtimeSource, /const keepOurs = childOwner\.hasManagedChild/u);
  assert.match(runtimeSource, /secondaryBaseUrl: childOwner\.status\(\)\.url/u);
  assert.match(runtimeSource, /#retireOpenCodeIfIdle\(\)/u);
  assert.match(runtimeSource, /if \(retired\.status\(\)\.url === this\.#openCode\.status\(\)\.url\) return;/u);
  assert.match(supervisorSource, /public get hasManagedChild/u);
  // The secondary feed forwards session events but never the connection state,
  // and marks sessions busy so the retirement tick knows when it can stop.
  assert.match(adapterSource, /private async runSecondaryEventLoop/u);
  assert.match(adapterSource, /if \(payload\.type === "server\.connected"\) continue;/u);
  assert.match(adapterSource, /public isSecondaryBusy/u);
  assert.match(adapterSource, /public setSecondaryBaseUrl/u);
});

test("OpenCode discovery finds the newest server URL left by the AI Desktop launcher", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "tethoq-discovery-"));
  try {
    await mkdir(join(root, "20260818T093021"));
    await writeFile(join(root, "20260818T093021", "main.log"),
      "spawning sidecar { url: 'http://127.0.0.1:63791' }\nserver ready { url: 'http://127.0.0.1:63791' }\n", "utf8");
    assert.equal(await discovery.discoverOpenCodeServerUrl(root), "http://127.0.0.1:63791/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode discovery skips launch directories that never report a server", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "tethoq-discovery-"));
  try {
    await mkdir(join(root, "20260818T101500"));
    await writeFile(join(root, "20260818T101500", "main.log"), "crashed before ready\n", "utf8");
    await mkdir(join(root, "20260818T093021"));
    await writeFile(join(root, "20260818T093021", "main.log"),
      "server ready { url: 'http://127.0.0.1:63791' }\n", "utf8");
    assert.equal(await discovery.discoverOpenCodeServerUrl(root), "http://127.0.0.1:63791/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode discovery takes the last server ready line and ignores noise", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "tethoq-discovery-"));
  try {
    await mkdir(join(root, "20260818T093021"));
    await writeFile(join(root, "20260818T093021", "main.log"),
      "listening on 5173\nserver ready { url: 'http://127.0.0.1:63791' }\nrestarting sidecar\nserver ready { url: 'http://127.0.0.1:63811' }\n", "utf8");
    assert.equal(await discovery.discoverOpenCodeServerUrl(root), "http://127.0.0.1:63811/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode discovery returns undefined when no launcher log exists", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "tethoq-discovery-"));
  try {
    assert.equal(await discovery.discoverOpenCodeServerUrl(root), undefined);
    assert.equal(await discovery.discoverOpenCodeServerUrl(join(root, "missing")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode endpoint resolution adopts a healthy discovered server and falls back when it dies", () => {
  const env = undefined;
  const defaultUrl = "http://127.0.0.1:4096/";
  const sidecar = "http://127.0.0.1:63791/";
  const managedSteadyState = { envUrl: env, discoveredUrl: undefined, discoveredHealthy: false, currentUrl: defaultUrl, adopted: false, currentExternal: false, defaultUrl };
  assert.equal(discovery.resolveOpenCodeEndpoint(managedSteadyState), undefined, "no discovery, not adopted: keep managing 4096");
  assert.deepEqual(discovery.resolveOpenCodeEndpoint({ ...managedSteadyState, discoveredUrl: sidecar, discoveredHealthy: true }), { url: sidecar, adopted: true }, "a healthy user server is adopted");
  assert.equal(discovery.resolveOpenCodeEndpoint({ ...managedSteadyState, discoveredUrl: sidecar, discoveredHealthy: false }), undefined, "an unhealthy discovery never replaces a running server");
  const adoptedSteadyState = { envUrl: env, discoveredUrl: sidecar, discoveredHealthy: true, currentUrl: sidecar, adopted: true, currentExternal: true, defaultUrl };
  assert.equal(discovery.resolveOpenCodeEndpoint(adoptedSteadyState), undefined, "steady state on the adopted server stays put");
  assert.deepEqual(discovery.resolveOpenCodeEndpoint({ ...adoptedSteadyState, discoveredUrl: "http://127.0.0.1:63811/", discoveredHealthy: true }), { url: "http://127.0.0.1:63811/", adopted: true }, "a moved user server replaces an older adopted endpoint even while the old endpoint still answers");
  assert.equal(discovery.resolveOpenCodeEndpoint({ ...adoptedSteadyState, discoveredHealthy: false }), undefined, "one failed discovery probe does not abandon an endpoint the supervisor still reports healthy");
  assert.deepEqual(discovery.resolveOpenCodeEndpoint({ ...adoptedSteadyState, currentExternal: false, discoveredHealthy: false }), { url: defaultUrl, adopted: false }, "a dead adopted server (stale log) falls back to the managed endpoint");
  assert.deepEqual(discovery.resolveOpenCodeEndpoint({ ...adoptedSteadyState, currentExternal: false, discoveredUrl: "http://127.0.0.1:63811/", discoveredHealthy: true }), { url: "http://127.0.0.1:63811/", adopted: true }, "a moved user server is adopted on its new port");
  assert.equal(discovery.resolveOpenCodeEndpoint({ ...managedSteadyState, envUrl: "http://127.0.0.1:9999/", discoveredUrl: sidecar, discoveredHealthy: true }), undefined, "an explicit TETHOQ_OPENCODE_URL always wins");
});

test("OpenCode failed-endpoint fallback avoids an inaccessible sidecar on the managed port", () => {
  const credentialsRequired = {
    state: "unavailable",
    url: discovery.DEFAULT_OPENCODE_URL,
    managed: false,
    reason: "credentials_required",
  };
  assert.deepEqual(discovery.resolveFailedOpenCodeFallback({
    envUrl: undefined,
    adopted: true,
    status: credentialsRequired,
  }), { url: discovery.FALLBACK_OPENCODE_URL, adopted: false });
  assert.deepEqual(discovery.resolveFailedOpenCodeFallback({
    envUrl: undefined,
    adopted: false,
    status: credentialsRequired,
  }), { url: discovery.FALLBACK_OPENCODE_URL, adopted: false });
  assert.equal(discovery.resolveFailedOpenCodeFallback({
    envUrl: "http://127.0.0.1:4096/",
    adopted: true,
    status: credentialsRequired,
  }), undefined, "an explicit endpoint must never be replaced");
  assert.equal(discovery.resolveFailedOpenCodeFallback({
    envUrl: "http://127.0.0.1:4096/",
    adopted: false,
    status: { state: "failed", url: discovery.DEFAULT_OPENCODE_URL, managed: false, reason: "port_in_use" },
  }), undefined, "an explicit endpoint also blocks bind-race fallback");
  assert.equal(discovery.resolveFailedOpenCodeFallback({
    envUrl: undefined,
    adopted: false,
    status: { state: "unavailable", url: discovery.FALLBACK_OPENCODE_URL, managed: false, reason: "credentials_required" },
  }), undefined, "credentials on a selected fallback remain a credential failure, not a bind retry");
  assert.deepEqual(discovery.resolveFailedOpenCodeFallback({
    envUrl: undefined,
    adopted: true,
    status: { state: "unavailable", url: "http://127.0.0.1:63791/", managed: false },
  }), { url: discovery.DEFAULT_OPENCODE_URL, adopted: false });
});

test("OpenCode same-cycle fallback functionally leaves an unauthorized adopted 4096 server alone", async () => {
  let primarySpawned = false;
  const primary = new openCode.OpenCodeSupervisor({
    url: discovery.DEFAULT_OPENCODE_URL,
    fetchHealth: async () => new Response(null, { status: 401 }),
    spawnProcess: () => {
      primarySpawned = true;
      throw new Error("the occupied 4096 endpoint must not be spawned over");
    },
  });
  let current = primary;
  let fallbackHealthChecks = 0;
  let fallbackSpawnArgs = [];
  const fallbackChild = {
    pid: undefined,
    exitCode: null,
    killed: false,
    stderr: undefined,
    once() { return this; },
    kill() { this.killed = true; return true; },
  };
  const ensuredUrls = [];
  const requestedFallbackUrls = [];
  const selectedFallbackUrls = [];
  const result = await discovery.ensureOpenCodeFallbackCycle({
    envUrl: undefined,
    adopted: true,
    ensureRunning: async () => {
      ensuredUrls.push(current.status().url);
      return await current.ensureRunning();
    },
    switchEndpoint: async (url) => {
      requestedFallbackUrls.push(url);
      const selectedUrl = await openCode.resolveAvailableOpenCodeServerUrl(url, {
        startPort: 4097,
        endPort: 4098,
        canBindPort: async (port) => port === 4098,
      });
      selectedFallbackUrls.push(selectedUrl);
      current = new openCode.OpenCodeSupervisor({
        url: selectedUrl,
        canBindPort: async (port) => port === 4098,
        fetchHealth: async () => new Response(null, { status: ++fallbackHealthChecks === 1 ? 503 : 200 }),
        spawnProcess: (_command, args) => {
          fallbackSpawnArgs = [...args];
          return fallbackChild;
        },
      });
    },
  });

  assert.equal(primarySpawned, false);
  assert.deepEqual(requestedFallbackUrls, [discovery.FALLBACK_OPENCODE_URL]);
  assert.deepEqual(selectedFallbackUrls, ["http://127.0.0.1:4098/"]);
  assert.deepEqual(ensuredUrls, [discovery.DEFAULT_OPENCODE_URL, "http://127.0.0.1:4098/"]);
  assert.match(fallbackSpawnArgs.join(" "), /--port 4098/u);
  assert.deepEqual(result, {
    status: { state: "managed", url: "http://127.0.0.1:4098/", managed: true },
    adopted: false,
  });
  await current.dispose();
});

test("OpenCode same-cycle fallback retries a bind race on a different candidate", async () => {
  let currentUrl = discovery.DEFAULT_OPENCODE_URL;
  let ensureCount = 0;
  const switchedUrls = [];
  const failedUrls = [];
  const result = await discovery.ensureOpenCodeFallbackCycle({
    envUrl: undefined,
    adopted: false,
    ensureRunning: async () => {
      ensureCount += 1;
      if (ensureCount === 1) {
        return { state: "unavailable", url: currentUrl, managed: false, reason: "credentials_required" };
      }
      if (ensureCount === 2) {
        return { state: "failed", url: currentUrl, managed: false, reason: "port_in_use" };
      }
      return { state: "managed", url: currentUrl, managed: true };
    },
    switchEndpoint: async (url, failedStatus) => {
      switchedUrls.push(url);
      failedUrls.push(failedStatus.url);
      currentUrl = switchedUrls.length === 1
        ? "http://127.0.0.1:4097/"
        : "http://127.0.0.1:4098/";
    },
  });

  assert.deepEqual(switchedUrls, [discovery.FALLBACK_OPENCODE_URL, discovery.FALLBACK_OPENCODE_URL]);
  assert.deepEqual(failedUrls, [discovery.DEFAULT_OPENCODE_URL, "http://127.0.0.1:4097/"]);
  assert.equal(ensureCount, 3);
  assert.deepEqual(result, {
    status: { state: "managed", url: "http://127.0.0.1:4098/", managed: true },
    adopted: false,
  });
});

test("OpenCode same-cycle fallback stops after its bounded bind retries", async () => {
  let currentUrl = discovery.DEFAULT_OPENCODE_URL;
  let ensureCount = 0;
  let switchCount = 0;
  const result = await discovery.ensureOpenCodeFallbackCycle({
    envUrl: undefined,
    adopted: false,
    ensureRunning: async () => {
      ensureCount += 1;
      return { state: "failed", url: currentUrl, managed: false, reason: "port_in_use" };
    },
    switchEndpoint: async () => {
      switchCount += 1;
      currentUrl = `http://127.0.0.1:${4096 + switchCount}/`;
    },
  });

  assert.equal(switchCount, discovery.MAX_OPENCODE_FALLBACK_SWITCHES);
  assert.equal(ensureCount, discovery.MAX_OPENCODE_FALLBACK_SWITCHES + 1);
  assert.equal(result.status.state, "failed");
  assert.equal(result.status.reason, "port_in_use");
  assert.equal(result.status.url, `http://127.0.0.1:${4096 + discovery.MAX_OPENCODE_FALLBACK_SWITCHES}/`);
  assert.equal(result.adopted, false);
});

test("OpenCode supervision keeps discovering the owning sidecar after startup", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  const backgroundStart = runtimeSource.match(/private startOpenCodeInBackground\([\s\S]*?\n  }/)?.[0] ?? "";
  const watchdogStart = runtimeSource.match(/private startOpenCodeWatchdog\([\s\S]*?\n  }/)?.[0] ?? "";
  const adoptServer = runtimeSource.match(/async #adoptOpenCodeServer\([\s\S]*?\n  }/)?.[0] ?? "";
  const ensureOpenCode = runtimeSource.match(/private async ensureOpenCodeOnce\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.match(backgroundStart, /this\.ensureOpenCode\(\)/u, "a sidecar that appears during background startup must be adopted");
  assert.match(watchdogStart, /ensureRunning: \(\) => this\.ensureOpenCode\(\)/u, "later watchdog ticks must repeat discovery, not only probe the old endpoint");
  assert.match(adoptServer, /replaceProviderAdapter\(this\.#createOpenCodeAdapter/u, "adopting a newly discovered endpoint must move the live provider subscription");
  assert.match(ensureOpenCode, /ensureOpenCodeFallbackCycle/u, "runtime supervision must execute the functionally tested same-cycle fallback");
  assert.match(ensureOpenCode, /resolveAvailableOpenCodeServerUrl\(url, \{ excludedPorts: failedFallbackPorts \}\)[\s\S]*?#adoptOpenCodeServer\(availableUrl\)/u, "runtime fallback must probe for a new free owned endpoint before repointing the supervisor");
});

test("OpenCode health probe authenticates and distinguishes a live server from a dead port", async () => {
  const { createServer } = await import("node:http");
  const expectedAuthorization = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
  const server = createServer((request, response) => {
    response.writeHead(request.url !== "/global/health"
      ? 404
      : request.headers.authorization === expectedAuthorization
        ? 200
        : 401);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    assert.equal(await discovery.isOpenCodeServerHealthy(url), false, "an authenticated endpoint must not be adopted without its credentials");
    assert.equal(await discovery.isOpenCodeServerHealthy(url, { username: "fixture-user", password: ["fixture", "password"].join("-") }), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await discovery.isOpenCodeServerHealthy(url), false, "a closed port must not probe healthy");
});
