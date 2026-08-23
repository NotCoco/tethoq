import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { earsModelKey, makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { EarsHelperStore, defaultEarsHelperStatePath } from "./ears_helper_store.js";

test("EARS helper mappings persist only provider-matched bounded session identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-ears-helper-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "bridge.json");
  const path = defaultEarsHelperStatePath(configPath);
  const store = new EarsHelperStore(path);
  const validKey = earsModelKey("direct", "openai::gpt-5.6-sol");
  const validId = makeGlobalSessionId("host", "direct", "helper-one");

  store.scheduleWrite({ [validKey]: validId });
  await store.flush();
  assert.deepEqual(await store.read(), { version: 1, helpers: { [validKey]: validId } });

  await writeFile(path, JSON.stringify({
    version: 1,
    helpers: {
      [validKey]: validId,
      [earsModelKey("codex", "gpt-5.6-sol")]: makeGlobalSessionId("host", "opencode", "wrong-provider"),
      malformed: "not-a-global-session",
    },
  }), "utf8");
  assert.deepEqual(await new EarsHelperStore(path).read(), { version: 1, helpers: { [validKey]: validId } });
  assert.match(await readFile(path, "utf8"), /wrong-provider/);
});
