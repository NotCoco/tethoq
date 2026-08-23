import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-session-refresh-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "session_refresh.mjs");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "session_refresh.ts")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const { mergeRefreshedSessions, sameSessionContext } = await import(`file:///${bundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const session = (overrides = {}) => ({
  id: "host/opencode/session-one",
  providerId: "opencode",
  title: "Task",
  state: "working",
  project: "project",
  workingDirectory: "C:\\project",
  preview: "",
  updatedAt: "2026-08-20T10:00:00.000Z",
  model: "deepseek-v4-pro",
  effort: "max",
  ...overrides,
});

test("a refresh response cannot restore a retry cleared by a newer live event", () => {
  const current = session({ updatedAt: "2026-08-20T10:00:02.000Z" });
  const stale = session({
    providerStatus: { kind: "retry", message: "Provider is temporarily busy" },
    updatedAt: "2026-08-20T10:00:01.000Z",
  });

  const merged = mergeRefreshedSessions([current], [stale], undefined, () => true);
  assert.equal(merged[0], current);
  assert.equal(merged[0].providerStatus, undefined);
});

test("an unchanged session still accepts canonical refresh state", () => {
  const current = session({ state: "working" });
  const refreshed = session({ state: "completed", updatedAt: "2026-08-20T10:00:03.000Z" });
  const merged = mergeRefreshedSessions([current], [refreshed], () => true, () => false);
  assert.equal(merged[0], refreshed);
});

test("an older refresh cannot resurrect a terminal failure", () => {
  const current = session({ state: "failed", updatedAt: "2026-08-20T10:00:02.000Z" });
  const stale = session({ state: "working", updatedAt: "2026-08-20T10:00:01.000Z" });
  const merged = mergeRefreshedSessions([current], [stale], undefined, () => false);
  assert.equal(merged[0], current);
});

test("an identical canonical session refresh preserves React identity", () => {
  const current = session({ state: "completed", providerStatus: { kind: "retry", message: "Waiting", retryAt: "2026-08-21T10:01:00.000Z" } });
  const refreshed = structuredClone(current);
  const merged = mergeRefreshedSessions([current], [refreshed], () => true, () => false);
  assert.equal(merged[0], current);
});

const context = (overrides = {}) => ({
  sessionId: "host/opencode/session-one",
  modelId: "deepseek-v4-pro",
  usedTokens: 24_000,
  contextWindowTokens: 128_000,
  usedPercent: 18.75,
  compactionThresholdTokens: 96_000,
  minimumThresholdTokens: 32_000,
  supportsManualCompaction: true,
  supportsThreshold: true,
  isCompacting: false,
  compactionKind: null,
  updatedAt: "2026-08-21T10:00:00.000Z",
  usage: { inputTokens: 20_000, outputTokens: 4_000, totalTokens: 24_000, currency: "USD" },
  ...overrides,
});

test("a heartbeat timestamp alone does not turn an unchanged context reading into UI state", () => {
  assert.equal(sameSessionContext(context(), context({ updatedAt: "2026-08-21T10:00:02.500Z" })), true);
});

test("displayed context and usage changes still refresh the UI", () => {
  assert.equal(sameSessionContext(context(), context({ usedTokens: 24_001 })), false);
  assert.equal(sameSessionContext(context(), context({ isCompacting: true, compactionKind: "automatic" })), false);
  assert.equal(sameSessionContext(context(), context({ usage: { inputTokens: 20_001, outputTokens: 4_000, totalTokens: 24_001, currency: "USD" } })), false);
});
