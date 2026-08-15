import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, type DelegationTask } from "../../../packages/protocol/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

function config(): BridgeConfig {
  return {
    version: 1,
    hostId: "host-delegation-timer",
    displayName: "Timer host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
}

function task(id: string, state: DelegationTask["state"]): DelegationTask {
  const now = new Date().toISOString();
  return {
    id,
    parentSessionId: "host-delegation-timer/fake/missing-parent",
    prompt: "Inspect the task",
    state,
    createdAt: now,
    updatedAt: now,
    children: [],
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("delegation polling runs only while a nonterminal runtime exists", async (t) => {
  let intervalCallback: (() => void) | undefined;
  const fakeTimer = { unref: () => fakeTimer } as unknown as NodeJS.Timeout;
  const setIntervalMock = t.mock.method(globalThis, "setInterval", ((callback: () => void) => {
    intervalCallback = callback;
    return fakeTimer;
  }) as typeof setInterval);
  const clearIntervalMock = t.mock.method(globalThis, "clearInterval", (() => undefined) as typeof clearInterval);

  const terminalBridge = new AgentBridge(config(), [], { delegations: [task("done", "completed")] });
  await terminalBridge.start();
  assert.equal(setIntervalMock.mock.calls.length, 0, "terminal restored work must not restart polling");
  await terminalBridge.dispose();

  const activeBridge = new AgentBridge(config(), [], { delegations: [task("active", "working")] });
  t.after(() => activeBridge.dispose());
  await activeBridge.start();
  assert.equal(setIntervalMock.mock.calls.length, 1, "nonterminal restored work must restart polling");
  assert.ok(intervalCallback);

  intervalCallback();
  await waitFor(() => clearIntervalMock.mock.calls.length === 1, "delegation timer shutdown");
  assert.equal(activeBridge.delegations()[0]?.state, "failed");
});
