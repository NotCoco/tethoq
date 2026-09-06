import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPiTools, piToolExtensionPath } from "./pi_tools.js";

test("Pi tools install the complete bounded browser workspace contract", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-pi-tools-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));

  await installPiTools({ userHome });
  const source = await readFile(piToolExtensionPath(userHome), "utf8");

  assert.match(source, /\["browser_get_state"/);
  assert.match(source, /\["browser_inspect_all"/);
  assert.match(source, /\["browser_activate"/);
  assert.match(source, /\["browser_set_muted"/);
  assert.match(source, /\["mesh_dispatch_delegation"/);
  assert.match(source, /new background tab/);
  assert.match(source, /activate: Type\.Optional\(Type\.Boolean\(\)\)/);
  const turnSupport = source.split(/\r?\n/u).find((line) => line.includes('["tethoq_turn_support"'));
  assert.ok(turnSupport);
  assert.match(turnSupport, /private turn-scoped Tethoq guidance/);
  assert.doesNotMatch(turnSupport, /eyes|image|visual|ask_eyes/iu,
    "the model-visible Pi definition must not reveal the private turn capability");
  assert.doesNotMatch(source, /\["ask_eyes"/u);
  assert.match(source, /const runtimeResponseTimeoutMs = 2_000/, "a silent runtime must not hang the Pi pipe forever");
  assert.match(source, /taskNotOwnedError/, "a later dead descriptor must not mask the ownership miss");
  assert.match(source, /forgetDeadRuntime/, "unreachable descriptors must be pruned instead of retried on every call");
  assert.match(source, /const eyesTransportFailure = "EYES could not inspect the image\. Try again or choose another EYES model\."/,
    "unreachable EYES transport must surface one sanitized failure, never a raw pipe diagnostic");
});

test("Pi tools recover from a stale configured descriptor through current deduplicated runtimes", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-pi-runtime-descriptors-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  const configuredRuntimePath = join(userHome, "configured-runtime.json");
  const legacyRuntimePath = join(userHome, ".tethoq", "mesh-tool-runtime.json");
  const runtimeDirectory = join(userHome, ".tethoq", "mesh-runtimes");
  await mkdir(runtimeDirectory, { recursive: true });
  await installPiTools({ userHome });
  const source = await readFile(piToolExtensionPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ Type \} from "typebox"\r?\n/u, "")
    .replace("const configuredRuntimePath = process.env.UAR_MESH_RUNTIME", `const configuredRuntimePath = ${JSON.stringify(configuredRuntimePath)}`)
    .replace("const legacyRuntimePath = join(homedir(), \".tethoq\", \"mesh-tool-runtime.json\")", `const legacyRuntimePath = ${JSON.stringify(legacyRuntimePath)}`)
    .replace("const runtimeDirectory = join(homedir(), \".tethoq\", \"mesh-runtimes\")", `const runtimeDirectory = ${JSON.stringify(runtimeDirectory)}`)
    .replace(/export default function tethoqTools[\s\S]*$/u, "export { call }\n");
  assert.notEqual(executableSource, source);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<unknown>;
  };

  const requestOrder: string[] = [];
  const configuredMiss = await piRuntimeFixture(
    { ok: false, code: "TASK_NOT_OWNED_HERE", error: "Task is owned by another Tethoq runtime" },
    () => requestOrder.push("configured"),
  );
  const liveOwner = await piRuntimeFixture(
    { ok: true, result: { tabs: [{ id: "tab-live" }] } },
    () => requestOrder.push("live"),
  );
  const semanticFailure = await piRuntimeFixture(
    { ok: false, error: "Browser operation failed fixture" },
    () => requestOrder.push("semantic"),
  );
  context.after(async () => {
    await configuredMiss.close();
    await liveOwner.close();
    await semanticFailure.close();
  });

  const configuredRuntime = {
    ...configuredMiss.runtime,
    startedAt: "2020-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  };
  const duplicateRuntime = { ...configuredRuntime, startedAt: "9999-01-01T00:00:00.000Z" };
  const liveRuntime = {
    ...liveOwner.runtime,
    startedAt: "2026-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  };
  const duplicateRuntimePath = join(runtimeDirectory, "configured-copy.json");
  const liveRuntimePath = join(runtimeDirectory, "live.json");
  await writeFile(configuredRuntimePath, JSON.stringify(configuredRuntime));
  await writeFile(duplicateRuntimePath, JSON.stringify(duplicateRuntime));
  await writeFile(liveRuntimePath, JSON.stringify(liveRuntime));

  assert.deepEqual(await loaded.call("session-one", "browser_get_state", {}), { tabs: [{ id: "tab-live" }] });
  assert.deepEqual(requestOrder, ["configured", "live"],
    "the configured descriptor stays first and its discovered duplicate is not called twice");
  assert.equal(configuredMiss.requestCount(), 1);

  requestOrder.length = 0;
  await rm(configuredRuntimePath);
  await rm(duplicateRuntimePath);
  assert.deepEqual(
    await loaded.call("session-one", "browser_get_state", {}),
    { tabs: [{ id: "tab-live" }] },
    "a deleted configured descriptor must fall through to current runtime discovery",
  );
  assert.deepEqual(requestOrder, ["live"]);

  requestOrder.length = 0;
  await writeFile(configuredRuntimePath, JSON.stringify({
    hostId: "host-stale",
    pipePath: unavailablePiPipePath(),
    token: "stale-token",
    startedAt: "9999-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  }));
  assert.deepEqual(
    await loaded.call("session-one", "browser_get_state", {}),
    { tabs: [{ id: "tab-live" }] },
    "an unreachable configured descriptor must fall through to the current task owner",
  );
  assert.deepEqual(requestOrder, ["live"]);

  requestOrder.length = 0;
  const liveRequestsBeforeSemanticFailure = liveOwner.requestCount();
  await writeFile(configuredRuntimePath, JSON.stringify({
    ...semanticFailure.runtime,
    startedAt: "2020-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  }));
  await assert.rejects(
    loaded.call("session-one", "browser_get_state", {}),
    (error: unknown) => {
      assert.equal((error as Error).message, "Browser operation failed fixture");
      return true;
    },
  );
  assert.deepEqual(requestOrder, ["semantic"]);
  assert.equal(liveOwner.requestCount(), liveRequestsBeforeSemanticFailure,
    "real tool failures must not be masked by routing to another runtime");
});

test("Pi tools prefer the ownership miss over later connect noise and prune dead descriptors", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-pi-runtime-prune-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  const configuredRuntimePath = join(userHome, "configured-runtime.json");
  const legacyRuntimePath = join(userHome, ".tethoq", "mesh-tool-runtime.json");
  const runtimeDirectory = join(userHome, ".tethoq", "mesh-runtimes");
  await mkdir(runtimeDirectory, { recursive: true });
  await installPiTools({ userHome });
  const source = await readFile(piToolExtensionPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ Type \} from "typebox"\r?\n/u, "")
    .replace("const configuredRuntimePath = process.env.UAR_MESH_RUNTIME", `const configuredRuntimePath = ${JSON.stringify(configuredRuntimePath)}`)
    .replace("const legacyRuntimePath = join(homedir(), \".tethoq\", \"mesh-tool-runtime.json\")", `const legacyRuntimePath = ${JSON.stringify(legacyRuntimePath)}`)
    .replace("const runtimeDirectory = join(homedir(), \".tethoq\", \"mesh-runtimes\")", `const runtimeDirectory = ${JSON.stringify(runtimeDirectory)}`)
    .replace(/export default function tethoqTools[\s\S]*$/u, "export { call }\n");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<unknown>;
  };

  const notOwner = await piRuntimeFixture({ ok: false, code: "TASK_NOT_OWNED_HERE", error: "Task is owned by another Tethoq runtime" });
  context.after(() => notOwner.close());
  const deadDescriptorPath = join(runtimeDirectory, "host-dead-1.json");
  await writeFile(deadDescriptorPath, JSON.stringify({
    hostId: "host-dead",
    pipePath: unavailablePiPipePath(),
    token: "dead-token",
    startedAt: "9999-01-01T00:00:00.000Z",
    tools: ["mesh_list_children"],
  }));
  await writeFile(join(runtimeDirectory, "live-not-owner.json"), JSON.stringify({
    ...notOwner.runtime,
    startedAt: "2020-01-01T00:00:00.000Z",
    tools: ["mesh_list_children"],
  }));

  await assert.rejects(
    loaded.call("session-one", "mesh_list_children", {}),
    (error: unknown) => {
      assert.equal((error as Error).message, "Task is owned by another Tethoq runtime");
      return true;
    },
  );
  await assert.rejects(
    () => readFile(deadDescriptorPath, "utf8"),
    "the unreachable descriptor must be pruned instead of retried on every call",
  );
});

interface PiRuntimeFixture {
  readonly hostId: string;
  readonly pipePath: string;
  readonly token: string;
}

function unavailablePiPipePath(): string {
  const name = `tethoq-pi-runtime-${process.pid}-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

async function piRuntimeFixture(response: unknown, onRequest?: () => void): Promise<{
  readonly runtime: PiRuntimeFixture;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}> {
  const pipePath = unavailablePiPipePath();
  let requests = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      requests += 1;
      onRequest?.();
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    runtime: { hostId: "host-live", pipePath, token: "fixture-token" },
    requestCount: () => requests,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}
