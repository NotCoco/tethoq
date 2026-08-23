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
      OPENCODE_SERVER_PASSWORD: "secret-token-value",
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
  assert.match(status.message, /requires credentials/);
  assert.match(status.message, /TETHOQ_OPENCODE_PASSWORD/);
  // A second server on a taken port would only fail to bind and then time out.
  assert.equal(spawned, false);
  // One probe per call: a repeat could re-enter a check that is still in flight.
  assert.equal(healthChecks, 1);
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

test("a second Tethoq launch can ask the running instance to quit cleanly", async () => {
  const { readFile } = await import("node:fs/promises");
  const indexSource = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  // The quit argument must route through the single-instance lock into app.quit,
  // which reaches before-quit and stops the managed OpenCode server.
  assert.match(indexSource, /QUIT_INSTANCE_ARGUMENT\s*=\s*"--quit-other"/u);
  assert.match(indexSource, /argv\.includes\(QUIT_INSTANCE_ARGUMENT\)[\s\S]{0,200}quitting\s*=\s*true/u);
  assert.match(indexSource, /app\.quit\(\)/u);

  const appSource = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  // A quiet live feed must still heal the open task on a calm cadence, so a
  // broken subscription cannot freeze the transcript until a relaunch.
  assert.match(appSource, /selectedSessionLastDeltaAt\(lastLiveDeltaBySession\.current,\s*sessionId,\s*lastLiveDeltaAt\.current\)/u);
  assert.match(appSource, /sessionNeedsTranscriptCatchUp\(session, current\?\.timelines\[selected\] \?\? \[\]\)/u);
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
  // The task list must keep itself fresh even when the live feed is quiet:
  // OpenCode is re-listed on a calm cadence (one cheap HTTP list, no provider
  // processes spawned) so titles, previews, and recency update without a click.
  assert.match(runtimeSource, /OPENCODE_RELIST_MS\s*=\s*15_000/u);
  assert.match(runtimeSource, /this\.#bridge\?\.reconnectProvider\("opencode"\)\.catch/u);
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

test("OpenCode supervision keeps discovering the owning sidecar after startup", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  const backgroundStart = runtimeSource.match(/private startOpenCodeInBackground\([\s\S]*?\n  }/)?.[0] ?? "";
  const watchdogStart = runtimeSource.match(/private startOpenCodeWatchdog\([\s\S]*?\n  }/)?.[0] ?? "";
  const adoptServer = runtimeSource.match(/async #adoptOpenCodeServer\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.match(backgroundStart, /this\.ensureOpenCode\(\)/u, "a sidecar that appears during background startup must be adopted");
  assert.match(watchdogStart, /ensureRunning: \(\) => this\.ensureOpenCode\(\)/u, "later watchdog ticks must repeat discovery, not only probe the old endpoint");
  assert.match(adoptServer, /replaceProviderAdapter\(this\.#createOpenCodeAdapter/u, "adopting a newly discovered endpoint must move the live provider subscription");
});

test("OpenCode health probe distinguishes a live server from a dead port", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/global/health" ? 200 : 404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    assert.equal(await discovery.isOpenCodeServerHealthy(url), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await discovery.isOpenCodeServerHealthy(url), false, "a closed port must not probe healthy");
});
