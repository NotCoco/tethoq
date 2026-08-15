import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const outputDirectory = join(tmpdir(), `tethoq-browser-idle-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });
const outfile = join(outputDirectory, "lifecycle.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/main/browser_idle_lifecycle.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
const { BrowserIdleLifecycle } = await import(`file:///${outfile.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

class FakeClock {
  now = 0;
  nextId = 1;
  tasks = new Map();
  timer = {
    set: (callback, delayMs) => {
      const id = this.nextId++;
      const handle = { id, unref() {} };
      this.tasks.set(id, { at: this.now + delayMs, callback });
      return handle;
    },
    clear: (handle) => { this.tasks.delete(handle.id); },
  };

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.now = target;
  }
}

test("hidden browser suspends once and showing cancels pending work", async () => {
  const clock = new FakeClock();
  let suspensions = 0;
  const lifecycle = new BrowserIdleLifecycle({ timer: clock.timer, hibernateAfterMs: 30, downloadRetryMs: 5, onSuspend: () => { suspensions += 1; return true; } });
  lifecycle.setInactive(true);
  lifecycle.setInactive(true);
  await clock.advance(29);
  assert.equal(suspensions, 0);
  lifecycle.setInactive(false);
  await clock.advance(10);
  assert.equal(suspensions, 0);
  lifecycle.setInactive(true);
  await clock.advance(30);
  assert.equal(suspensions, 1);
  await clock.advance(30);
  assert.equal(suspensions, 1);
});

test("active download defers suspension and completion runs an overdue attempt", async () => {
  const clock = new FakeClock();
  let suspensions = 0;
  const lifecycle = new BrowserIdleLifecycle({ timer: clock.timer, hibernateAfterMs: 30, downloadRetryMs: 10, onSuspend: () => { suspensions += 1; return true; } });
  lifecycle.setDownloadsActive(true);
  lifecycle.setInactive(true);
  await clock.advance(30);
  assert.equal(suspensions, 0);
  lifecycle.setDownloadsActive(false);
  await clock.advance(0);
  assert.equal(suspensions, 1);
});

test("dispose clears its timer", async () => {
  const clock = new FakeClock();
  let suspensions = 0;
  const lifecycle = new BrowserIdleLifecycle({ timer: clock.timer, hibernateAfterMs: 30, onSuspend: () => { suspensions += 1; return true; } });
  lifecycle.setInactive(true);
  lifecycle.dispose();
  await clock.advance(40);
  assert.equal(suspensions, 0);
  assert.equal(clock.tasks.size, 0);
});
