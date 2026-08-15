import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const directory = join(tmpdir(), `tethoq-readiness-${process.pid}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const bundlePath = join(directory, "readiness.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/main/desktop_readiness.ts", import.meta.url))],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const readiness = await import(`file:///${bundlePath.replaceAll("\\", "/")}`);

test("Desktop publishes only an opaque loopback readiness route and removes it on shutdown", async (context) => {
  const path = join(directory, "desktop-readiness.json");
  const handle = await readiness.startDesktopReadiness(path);
  context.after(async () => {
    await handle.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const descriptor = JSON.parse(await readFile(path, "utf8"));
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.port, handle.port);
  assert.match(descriptor.token, /^[A-Za-z0-9_-]{43}$/);
  const publicProbe = await fetch(`http://127.0.0.1:${handle.port}/tethoq-desktop-ready/not-the-token`);
  assert.equal(publicProbe.status, 404);
  const authenticatedProbe = await fetch(`http://127.0.0.1:${handle.port}/tethoq-desktop-ready/${descriptor.token}`);
  assert.equal(authenticatedProbe.status, 204);
  await handle.dispose();
  await assert.rejects(readFile(path, "utf8"), /ENOENT/);
});
