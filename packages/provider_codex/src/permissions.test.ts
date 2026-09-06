import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSessionPermissions } from "./permissions.js";

const nativePolicy = { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } };
const unrestricted = { requirements: null };

test("Codex permission selections persist per task and concurrent changes retain both controls", async (t) => {
  const prefix = join(tmpdir(), "codex-permissions-");
  const directory = await mkdtemp(prefix);
  t.after(async () => { assert.ok(directory.startsWith(prefix)); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "settings.json");
  const state = new CodexSessionPermissions(path);
  const available = await state.describe("selected", nativePolicy, unrestricted);
  await Promise.all([
    state.set("selected", "approvalPolicy", "never", available),
    state.set("selected", "sandbox", "read-only", available),
  ]);
  assert.deepEqual(await state.turnOverrides("selected"), { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  assert.deepEqual(await state.turnOverrides("unselected"), {});
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { selected: { approvalPolicy: "never", sandbox: "read-only" } });
  const restored = new CodexSessionPermissions(path);
  await assert.rejects(restored.turnOverrides("selected"), /requirements/);
  assert.deepEqual(await restored.turnOverrides("selected", async () => unrestricted), { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  assert.deepEqual(await restored.turnOverrides("unselected", async () => { throw new Error("must not query unrelated tasks"); }), {});
});

test("Codex native requirements cannot be bypassed through a displayed current policy", async () => {
  const state = new CodexSessionPermissions();
  const available = await state.describe("locked", { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } }, {
    requirements: { allowedApprovalPolicies: ["on-request"], allowedSandboxModes: ["read-only"] },
  });
  assert.deepEqual(available.controls.map((control) => control.options.filter((option) => !option.disabled).map((option) => option.value)), [["on-request"], ["read-only"]]);
  await assert.rejects(state.set("locked", "approvalPolicy", "never", available), /does not allow/);
  await assert.rejects(state.set("locked", "sandbox", "danger-full-access", available), /does not allow/);
  await assert.rejects(state.set("locked", "unknown", "read-only", available), /does not allow/);
  assert.deepEqual(await state.turnOverrides("locked"), {});
});

test("Codex saved settings are revalidated when native requirements tighten or disappear", async () => {
  const state = new CodexSessionPermissions();
  const available = await state.describe("selected", nativePolicy, unrestricted);
  await state.set("selected", "sandbox", "danger-full-access", available);
  await assert.rejects(state.turnOverrides("selected", async () => ({ requirements: { allowedSandboxModes: ["workspace-write"] } })), /no longer allow/);
  await assert.rejects(state.turnOverrides("selected", async () => ({})), /could not verify/);
  assert.deepEqual(await state.turnOverrides("selected", async () => unrestricted), { sandboxPolicy: { type: "dangerFullAccess" } });
});

test("Codex does not invent controls when requirements are unavailable and preserves native custom policies", async () => {
  const state = new CodexSessionPermissions();
  const unavailable = await state.describe("unknown", nativePolicy, {});
  assert.deepEqual(unavailable.controls, []);
  await assert.rejects(state.set("unknown", "approvalPolicy", "never", unavailable), /does not allow/);
  const custom = await state.describe("custom", { approvalPolicy: { reject: { sandbox_approval: true } }, sandbox: { type: "externalSandbox", networkAccess: "enabled" } }, unrestricted);
  assert.deepEqual(custom.controls.map((control) => control.value), ["custom", "custom"]);
  assert.ok(custom.controls.every((control) => control.options.find((option) => option.value === "custom")?.disabled));
  assert.deepEqual(await state.turnOverrides("custom"), {});
});

test("Codex ignores unrecognized persisted policy values instead of sending them to app-server", async (t) => {
  const prefix = join(tmpdir(), "codex-permissions-invalid-");
  const directory = await mkdtemp(prefix);
  t.after(async () => { assert.ok(directory.startsWith(prefix)); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({ bad: { approvalPolicy: "invented", sandbox: "unrestricted", unrelated: "keep out" } }));
  const state = new CodexSessionPermissions(path);
  assert.deepEqual(await state.turnOverrides("bad", async () => unrestricted), {});
});
