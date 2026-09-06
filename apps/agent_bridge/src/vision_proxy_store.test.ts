import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { VisionProxyStore, defaultVisionProxyStatePath } from "./vision_proxy_store.js";

test("EYES state persists provider-matched helper identities and drops malformed records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-eyes-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = defaultVisionProxyStatePath(join(root, "bridge.json"));
  const parentId = makeGlobalSessionId("host", "codex", "parent");
  const helperId = makeGlobalSessionId("host", "direct", "helper");
  const store = new VisionProxyStore(path, "host");

  await store.scheduleWrite({
    [parentId]: {
      selection: { providerId: "direct", modelId: "gemini-vision", reasoningEffort: "low" },
      helperSessionId: helperId,
      helperToolIsolation: 1,
    },
  }, [helperId]);
  assert.deepEqual(await store.read(), {
    version: 1,
    proxies: {
      [parentId]: {
        selection: { providerId: "direct", modelId: "gemini-vision", reasoningEffort: "low" },
        helperSessionId: helperId,
        helperToolIsolation: 1,
      },
    },
    helperSessionIds: [helperId],
  });

  await writeFile(path, JSON.stringify({
    version: 1,
    proxies: {
      [parentId]: { selection: { providerId: "direct", modelId: "gemini-vision" }, helperSessionId: helperId },
      malformed: { selection: { providerId: "direct", modelId: "gemini-vision" }, helperSessionId: "not-a-session" },
      [makeGlobalSessionId("host", "codex", "wrong-provider")]: {
        selection: { providerId: "direct", modelId: "gemini-vision" },
        helperSessionId: makeGlobalSessionId("host", "opencode", "ordinary-task"),
      },
    },
    helperSessionIds: [helperId, "not-a-session", makeGlobalSessionId("other-host", "direct", "other")],
  }), "utf8");
  assert.deepEqual(await new VisionProxyStore(path, "host").read(), {
    version: 1,
    proxies: {
      [parentId]: { selection: { providerId: "direct", modelId: "gemini-vision" }, helperSessionId: helperId },
    },
    helperSessionIds: [helperId],
  });
});

test("EYES state never ages retired helper privacy markers out after the old limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-eyes-store-many-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = defaultVisionProxyStatePath(join(root, "bridge.json"));
  const helperSessionIds = Array.from({ length: 1_005 }, (_, index) =>
    makeGlobalSessionId("host", "eyes", `retired-helper-${index}`));

  await new VisionProxyStore(path, "host").scheduleWrite({}, helperSessionIds);
  const restarted = await new VisionProxyStore(path, "host").read();

  assert.deepEqual(restarted.helperSessionIds, helperSessionIds);
});
