import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(join(appRoot, "node_modules", ".schedule-dispatch-test-"));
const bundle = join(output, "runtime.cjs");
await build({
  entryPoints: [join(appRoot, "src/main/runtime.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  logLevel: "silent",
});
const { DesktopRuntime } = createRequire(import.meta.url)(bundle);
test.after(() => rm(output, { recursive: true, force: true }));

test("an overdue OpenCode schedule waits for cold startup without delaying another provider", async () => {
  let ready;
  const startup = new Promise((resolve) => { ready = resolve; });
  const sent = [];
  let connected = false;
  let starts = 0;
  const runtime = {
    ensureOpenCode: () => { starts += 1; return startup; },
    reconnectOpenCodeProvider: async () => { connected = true; },
  };
  const bridge = {
    dispatchScheduledTask: async (task) => {
      if (task.providerId === "opencode") assert.equal(connected, true, "scheduled creation outran provider startup");
      sent.push(task.requestId);
      return { targetSessionId: `host/${task.providerId}/${task.requestId}` };
    },
  };
  const openCode = DesktopRuntime.prototype.dispatchScheduledTask.call(runtime, bridge, { providerId: "opencode", requestId: "overdue" });
  await DesktopRuntime.prototype.dispatchScheduledTask.call(runtime, bridge, { providerId: "codex", requestId: "independent" });
  assert.deepEqual(sent, ["independent"]);
  assert.equal(starts, 1);
  ready({ state: "managed" });
  assert.deepEqual(await openCode, { targetSessionId: "host/opencode/overdue" });
  assert.deepEqual(sent, ["independent", "overdue"]);
});

test("scheduled Mesh also prepares OpenCode and a startup failure creates no provider task", async () => {
  let sent = 0;
  let starts = 0;
  const task = { providerId: "codex", meshTargets: [{ providerId: "opencode" }] };
  const runtime = {
    ensureOpenCode: async () => { starts += 1; return { state: "failed", message: "OpenCode startup failed" }; },
    reconnectOpenCodeProvider: async () => { throw new Error("must not connect a failed server"); },
  };
  const bridge = { dispatchScheduledTask: async () => { sent += 1; } };
  await assert.rejects(DesktopRuntime.prototype.dispatchScheduledTask.call(runtime, bridge, task), /OpenCode startup failed/u);
  assert.equal(starts, 1);
  assert.equal(sent, 0);
});
