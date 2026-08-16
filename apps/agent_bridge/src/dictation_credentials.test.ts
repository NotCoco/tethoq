import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DictationCredentialStore } from "./dictation_credentials.js";

test("dictation API keys are encrypted at rest and reload with the host identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-dictation-credentials-"));
  const path = join(directory, "credentials.json");
  const secret = ["test", "host", "identity"].join("-");
  const apiKey = ["sk", "test", "dictation", "value"].join("-");
  try {
    const store = new DictationCredentialStore(path, secret);
    assert.deepEqual(await store.read(), {});
    await store.set("openai-stt", apiKey);

    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, new RegExp(apiKey));
    assert.match(persisted, /"openai-stt"/);

    const reloaded = new DictationCredentialStore(path, secret);
    assert.equal((await reloaded.read())["openai-stt"], apiKey);
    await reloaded.set("openai-stt", undefined);
    assert.deepEqual(await new DictationCredentialStore(path, secret).read(), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dictation credential files are bound to the host identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-dictation-credentials-"));
  const path = join(directory, "credentials.json");
  try {
    const store = new DictationCredentialStore(path, "first-host-identity");
    await store.read();
    await store.set("xai-stt", "xai-test-private-key");
    await assert.rejects(
      () => new DictationCredentialStore(path, "different-host-identity").read(),
      /could not be decrypted/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
