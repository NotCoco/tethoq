import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeMeshToolPath, installOpenCodeMeshTools } from "./opencode_tools.js";

test("OpenCode mesh tools install with session-scoped context outside the real user home", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-tools-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  assert.match(source, /context\.sessionID/);
  assert.match(source, /mesh_message_child/);
  assert.match(source, /mesh_list_sessions/);
  assert.match(source, /mesh_message_session/);
  assert.doesNotMatch(source, /UAR_MESH_TOKEN/);
});
