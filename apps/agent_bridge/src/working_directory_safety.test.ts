import assert from "node:assert/strict";
import { homedir } from "node:os";
import { win32 } from "node:path";
import test from "node:test";

import { createHostIdentity } from "../../../packages/protocol/src/index.js";
import type { CreateSessionOptions } from "../../../packages/provider_contract/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

const hostId = "host-working-directory-safety";
const config: BridgeConfig = {
  version: 1,
  hostId,
  displayName: "Working-directory safety test host",
  identity: createHostIdentity(),
  enabledProviders: ["fake"],
};

class CapturingProvider extends FakeProviderAdapter {
  public readonly creates: CreateSessionOptions[] = [];

  public constructor() {
    super({ hostId, providerId: "fake", sessionCount: 0 });
  }

  public override async createSession(options: CreateSessionOptions) {
    this.creates.push(options);
    return await super.createSession(options);
  }
}

test("blank new-task directories use the host's safe default instead of process.cwd", async (t) => {
  const originalCwd = process.cwd;
  Object.defineProperty(process, "cwd", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => "C:\\Windows\\System32",
  });
  t.after(() => Object.defineProperty(process, "cwd", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: originalCwd,
  }));

  const provider = new CapturingProvider();
  const bridge = new AgentBridge(config, [provider], {
    defaultWorkingDirectory: "C:\\Users\\Example User\\Documents",
  });
  t.after(() => bridge.dispose());

  await bridge.createSession("fake", { workingDirectory: "   " });

  assert.equal(provider.creates.length, 1);
  assert.equal(provider.creates[0]?.workingDirectory, "C:\\Users\\Example User\\Documents");
});

test("an explicit Windows system folder is rejected before provider creation", async (t) => {
  const provider = new CapturingProvider();
  const bridge = new AgentBridge(config, [provider], {
    defaultWorkingDirectory: "C:\\Users\\Example User\\Documents",
  });
  t.after(() => bridge.dispose());

  await assert.rejects(
    () => bridge.createSession("fake", { workingDirectory: "c:/WINDOWS/System32/drivers" }),
    /reserved by Windows.*Documents.*user-owned/iu,
  );
  assert.equal(provider.creates.length, 0);
});

test("relative new-task directories resolve beneath the safe default, never process.cwd", async (t) => {
  const originalCwd = process.cwd;
  Object.defineProperty(process, "cwd", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => "C:\\Windows\\System32",
  });
  t.after(() => Object.defineProperty(process, "cwd", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: originalCwd,
  }));

  const safeDefault = "C:\\Users\\Example User\\Documents";
  const provider = new CapturingProvider();
  const bridge = new AgentBridge(config, [provider], { defaultWorkingDirectory: safeDefault });
  t.after(() => bridge.dispose());

  await bridge.createSession("fake", { workingDirectory: "remote CLI" });

  assert.equal(provider.creates.length, 1);
  assert.equal(provider.creates[0]?.workingDirectory, win32.join(safeDefault, "remote CLI"));
  assert.notEqual(provider.creates[0]?.workingDirectory, win32.join("C:\\Windows\\System32", "remote CLI"));
});

test("relative new-task directories cannot escape the safe default", async (t) => {
  const provider = new CapturingProvider();
  const bridge = new AgentBridge(config, [provider], {
    defaultWorkingDirectory: "C:\\Users\\Example User\\Documents",
  });
  t.after(() => bridge.dispose());

  await assert.rejects(
    () => bridge.createSession("fake", { workingDirectory: "..\\..\\..\\Windows\\System32" }),
    /leaves the default workspace/iu,
  );
  assert.equal(provider.creates.length, 0);
});

test("relative directories inherited by child tasks use the same safe resolver", async (t) => {
  const safeDefault = "C:\\Users\\Example User\\Documents";
  const provider = new CapturingProvider();
  const parent = await provider.createSession({ workingDirectory: "inherited project" });
  provider.creates.length = 0;
  const bridge = new AgentBridge(config, [provider], { defaultWorkingDirectory: safeDefault });
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  await bridge.contextHandoff(parent.id);

  assert.equal(provider.creates.length, 1);
  assert.equal(provider.creates[0]?.workingDirectory, win32.join(safeDefault, "inherited project"));
});

test("standalone Bridge construction retains a safe user-home fallback", async (t) => {
  const provider = new CapturingProvider();
  const bridge = new AgentBridge(config, [provider]);
  t.after(() => bridge.dispose());

  await bridge.createSession("fake", { workingDirectory: "" });

  assert.equal(provider.creates.length, 1);
  assert.equal(provider.creates[0]?.workingDirectory, homedir());
});
