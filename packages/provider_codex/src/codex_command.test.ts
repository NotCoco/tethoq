import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CodexCommandResolver, resolveCodexCommand } from "./codex_command.js";

test("Codex command discovery chooses the newest Desktop-managed CLI over stale PATH", async () => {
  const pathCommand = "C:\\tools\\nodejs\\codex.cmd";
  const desktopRoot = "C:\\Users\\person\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  const desktopCurrent = "C:\\Users\\person\\AppData\\Local\\OpenAI\\Codex\\bin\\current-hash\\codex.exe";
  const probeCalls = new Map<string, number>();
  const versions = new Map([
    [pathCommand, "codex-cli 0.147.0"],
    [desktopRoot, "codex-cli 0.130.0-alpha.5"],
    [desktopCurrent, "codex-cli 0.152.1"],
  ]);
  const resolver = new CodexCommandResolver({
    platform: "win32",
    pathCommand,
    desktopCommands: [desktopRoot, desktopCurrent],
    probeVersion: async (command) => {
      probeCalls.set(command, (probeCalls.get(command) ?? 0) + 1);
      return versions.get(command);
    },
  });

  const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);

  assert.deepEqual(first, { command: desktopCurrent, source: "desktop", version: "0.152.1" });
  assert.deepEqual(second, first);
  assert.deepEqual([...probeCalls.entries()], [
    [pathCommand, 1],
    [desktopRoot, 1],
    [desktopCurrent, 1],
  ], "detection and launch must share one cached probe pass");
});

test("an explicit Codex command remains authoritative over newer discovered binaries", async () => {
  let probes = 0;
  const selection = await resolveCodexCommand({
    configuredCommand: "D:\\Pinned\\codex.exe",
    platform: "win32",
    pathCommand: "C:\\old\\codex.cmd",
    desktopCommands: ["C:\\new\\codex.exe"],
    probeVersion: async () => {
      probes += 1;
      return "codex-cli 99.0.0";
    },
  });

  assert.deepEqual(selection, { command: "D:\\Pinned\\codex.exe", source: "configured" });
  assert.equal(probes, 0);
});

test("invalid Codex candidates are ignored and equal versions prefer Desktop", async () => {
  const pathCommand = "C:\\path\\codex.cmd";
  const corruptDesktop = "C:\\desktop\\corrupt\\codex.exe";
  const matchingDesktop = "C:\\desktop\\matching\\codex.exe";
  const selection = await resolveCodexCommand({
    platform: "win32",
    pathCommand,
    desktopCommands: [corruptDesktop, matchingDesktop, matchingDesktop.toLocaleUpperCase()],
    probeVersion: async (command) => {
      if (command === corruptDesktop) return "not a version";
      return "codex-cli 0.152.1";
    },
  });

  assert.deepEqual(selection, { command: matchingDesktop, source: "desktop", version: "0.152.1" });
});

test("Desktop remains the compatibility authority when PATH happens to be newer", async () => {
  const pathCommand = "C:\\path\\codex.cmd";
  const desktopCommand = "C:\\desktop\\codex.exe";
  const selection = await resolveCodexCommand({
    platform: "win32",
    pathCommand,
    desktopCommands: [desktopCommand],
    probeVersion: async (command) => command === pathCommand ? "codex-cli 0.160.0" : "codex-cli 0.152.1",
  });

  assert.deepEqual(selection, { command: desktopCommand, source: "desktop", version: "0.152.1" });
});

test("a Desktop root executable discovered through PATH retains Desktop compatibility authority", async () => {
  const desktopRoot = "C:\\desktop\\bin\\codex.exe";
  const olderDesktopHash = "C:\\desktop\\bin\\old-hash\\codex.exe";
  const selection = await resolveCodexCommand({
    platform: "win32",
    pathCommand: desktopRoot.toLocaleUpperCase(),
    desktopCommands: [desktopRoot, olderDesktopHash],
    probeVersion: async (command) => command.toLocaleLowerCase() === desktopRoot.toLocaleLowerCase()
      ? "codex-cli 0.154.0"
      : "codex-cli 0.153.0",
  });

  assert.deepEqual(selection, { command: desktopRoot, source: "desktop", version: "0.154.0" });
});

test("an invalidated resolver sees a newer Desktop binary that appeared mid-run", async () => {
  const pathCommand = "C:\\path\\codex.cmd";
  const desktopCommands = ["C:\\desktop\\old\\codex.exe"];
  const versions = new Map([
    [pathCommand, "codex-cli 0.147.0"],
    [desktopCommands[0]!, "codex-cli 0.151.0"],
  ]);
  const resolver = new CodexCommandResolver({
    platform: "win32",
    pathCommand,
    desktopCommands,
    probeVersion: async (command) => versions.get(command),
  });
  assert.equal((await resolver.resolve()).version, "0.151.0");

  const updated = "C:\\desktop\\new\\codex.exe";
  desktopCommands.push(updated);
  versions.set(updated, "codex-cli 0.152.1");
  resolver.invalidate();

  assert.deepEqual(await resolver.resolve(), { command: updated, source: "desktop", version: "0.152.1" });
});

test("a failed discovery is not cached across a Desktop update", async () => {
  let available = false;
  let probes = 0;
  const resolver = new CodexCommandResolver({
    platform: "win32",
    pathCommand: "C:\\path\\codex.cmd",
    desktopCommands: ["C:\\desktop\\codex.exe"],
    probeVersion: async (command) => {
      probes += 1;
      return available && command.includes("desktop") ? "codex-cli 0.152.1" : undefined;
    },
  });

  await assert.rejects(() => resolver.resolve(), /No compatible Codex CLI/iu);
  available = true;
  assert.deepEqual(await resolver.resolve(), {
    command: "C:\\desktop\\codex.exe",
    source: "desktop",
    version: "0.152.1",
  });
  assert.equal(probes, 4, "both candidates are probed again after the failed pass");
});

test("non-Windows Codex command resolution retains native PATH behavior", async () => {
  let probes = 0;
  const selection = await resolveCodexCommand({
    platform: "linux",
    probeVersion: async () => {
      probes += 1;
      return "codex-cli 0.152.1";
    },
  });

  assert.deepEqual(selection, { command: "codex", source: "path" });
  assert.equal(probes, 0);
});

test("a fresh Windows profile can use its own PATH installation without Codex Desktop", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "tethoq another user "));
  const bin = join(profile, "Tools with spaces");
  const command = join(bin, "codex.exe");
  await mkdir(bin);
  await writeFile(command, "portable fixture");
  t.after(() => rm(profile, { recursive: true, force: true }));
  const selection = await resolveCodexCommand({
    platform: "win32",
    env: { LOCALAPPDATA: join(profile, "AppData", "Local"), PATH: bin, PATHEXT: ".EXE" },
    probeVersion: async (candidate) => candidate === command ? "codex-cli 0.153.4" : undefined,
  });
  assert.deepEqual(selection, { command, source: "path", version: "0.153.4" });
});

test("macOS command discovery uses the local installation without Windows paths", async () => {
  assert.deepEqual(await resolveCodexCommand({ platform: "darwin", env: {} }), { command: "codex", source: "path" });
});

test("Codex command discovery uses the caller-supplied LOCALAPPDATA environment", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "tethoq-codex-command-env-"));
  const desktopCommand = join(localAppData, "OpenAI", "Codex", "bin", "fresh-hash", "codex.exe");
  await mkdir(dirname(desktopCommand), { recursive: true });
  await writeFile(desktopCommand, "test fixture", "utf8");
  t.after(() => rm(localAppData, { recursive: true, force: true }));

  const selection = await resolveCodexCommand({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    pathCommand: "missing-path-codex",
    probeVersion: async (command) => command === desktopCommand ? "codex-cli 0.153.0" : undefined,
  });

  assert.deepEqual(selection, { command: desktopCommand, source: "desktop", version: "0.153.0" });
});
