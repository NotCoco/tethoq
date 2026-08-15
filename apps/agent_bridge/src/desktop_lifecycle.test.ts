import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHostIdentity, type RequestEnvelope } from "../../../packages/protocol/src/index.js";
import { AgentBridge } from "./bridge.js";
import {
  InstalledDesktopLifecycle,
  trustedDesktopExecutablePath,
  trustedDesktopReadinessPath,
  type DesktopReadinessDescriptor,
} from "./desktop_lifecycle.js";
import { BridgeRequestRouter, type DesktopLifecycleController } from "./request_router.js";
import type { BridgeConfig } from "./config.js";
import type { ChildProcess } from "node:child_process";

const config: BridgeConfig = {
  version: 1,
  hostId: "host-desktop-lifecycle",
  displayName: "Desktop lifecycle test",
  identity: createHostIdentity(),
  enabledProviders: [],
};

function request(type: string, requestId: string, payload: Record<string, never> = {}): RequestEnvelope {
  return {
    protocolVersion: 1,
    messageId: `message-${requestId}`,
    hostId: config.hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type,
    requestId,
    payload,
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 1234, connected: false, killed: false, exitCode: null, signalCode: null, spawnargs: [], spawnfile: "Tethoq.exe", stdio: [null, null, null, null, null] });
  return child;
}

test("desktop lifecycle RPCs expose the stable contract and reject payload injection", async (context) => {
  const bridge = new AgentBridge(config, []);
  context.after(() => bridge.dispose());
  await bridge.start();
  let wakes = 0;
  const lifecycle: DesktopLifecycleController = {
    status: () => ({ state: "stopped" }),
    wake: async () => { wakes += 1; return { state: "running", launched: true }; },
  };
  const router = new BridgeRequestRouter(bridge, lifecycle);

  const status = await router.handle(request("desktop.status", "desktop-status"));
  assert.equal(status.ok, true);
  assert.deepEqual(status.payload, { state: "stopped" });
  const wake = await router.handle(request("desktop.wake", "desktop-wake"));
  assert.equal(wake.ok, true);
  assert.deepEqual(wake.payload, { state: "running", launched: true });
  assert.equal(wakes, 1);

  const rejected = await router.handle({ ...request("desktop.wake", "desktop-injection"), payload: { executable: "C:\\malware.exe" } });
  assert.equal(rejected.ok, false);
  assert.equal(wakes, 1);
  assert.match(rejected.error?.message ?? "", /does not accept any payload fields/u);
});

test("standalone Bridge reports stopped but fails wake with a stable not-installed code", async (context) => {
  const bridge = new AgentBridge(config, []);
  context.after(() => bridge.dispose());
  await bridge.start();
  const router = new BridgeRequestRouter(bridge);
  const status = await router.handle(request("desktop.status", "standalone-status"));
  assert.deepEqual(status.payload, { state: "stopped" });
  const wake = await router.handle(request("desktop.wake", "standalone-wake"));
  assert.equal(wake.ok, false);
  assert.equal(wake.error?.code, "DESKTOP_NOT_INSTALLED");
  assert.equal(wake.error?.retryable, false);
});

test("installed lifecycle launches only its constructor-fixed executable and coalesces wakes", async () => {
  const readiness: DesktopReadinessDescriptor = { version: 1, port: 43_210, token: "a".repeat(43) };
  const launched: string[] = [];
  let ready = false;
  const lifecycle = new InstalledDesktopLifecycle({
    executablePath: "C:\\Program Files\\Tethoq\\Tethoq.exe",
    resolveReadiness: async () => readiness,
    pathExists: async () => true,
    probe: async (value) => {
      assert.deepEqual(value, readiness);
      return ready;
    },
    launch: (path) => {
      launched.push(path);
      setTimeout(() => { ready = true; }, 1);
      return fakeChild();
    },
    readyTimeoutMs: 250,
    retryDelayMs: 2,
  });

  const [first, second] = await Promise.all([lifecycle.wake(), lifecycle.wake()]);
  assert.deepEqual(first, { state: "running", launched: true });
  assert.deepEqual(second, first);
  assert.deepEqual(launched, ["C:\\Program Files\\Tethoq\\Tethoq.exe"]);
});

test("Desktop discovery uses only trusted embedded, default-install, or local override paths", () => {
  const embeddedRuntime = "C:\\Apps\\Tethoq\\resources\\bridge-companion\\resources\\bridge\\runtime\\node.exe";
  assert.equal(
    trustedDesktopExecutablePath({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }, embeddedRuntime),
    "C:\\Apps\\Tethoq\\Tethoq.exe",
  );
  assert.equal(
    trustedDesktopExecutablePath({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }, "C:\\Apps\\Tethoq Bridge\\resources\\bridge\\runtime\\node.exe"),
    "C:\\Users\\Test\\AppData\\Local\\Programs\\Tethoq\\Tethoq.exe",
  );
  assert.equal(
    trustedDesktopExecutablePath({ TETHOQ_DESKTOP_EXECUTABLE: "D:\\Custom\\Tethoq.exe" }, embeddedRuntime),
    "D:\\Custom\\Tethoq.exe",
  );
  assert.equal(trustedDesktopExecutablePath({ TETHOQ_DESKTOP_EXECUTABLE: "relative.exe" }, embeddedRuntime), undefined);
  assert.equal(
    trustedDesktopReadinessPath({ APPDATA: "C:\\Users\\Test\\AppData\\Roaming" }),
    "C:\\Users\\Test\\AppData\\Roaming\\Tethoq\\desktop-readiness.json",
  );
  assert.equal(trustedDesktopReadinessPath({ TETHOQ_DESKTOP_READINESS_FILE: "relative.json" }), undefined);
});
