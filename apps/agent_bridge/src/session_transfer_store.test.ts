import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTransferStateStore, defaultSessionTransferStatePath } from "./session_transfer_store.js";

test("session transfer state persists restart-safe handoff and branch data", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-session-transfer-"));
  const configPath = join(root, "config.json");
  const path = defaultSessionTransferStatePath(configPath);
  try {
    const store = new SessionTransferStateStore(path);
    assert.deepEqual(await store.read(), { version: 1, transfers: [] });
    store.scheduleWrite([{
      sessionId: "host/provider/handoff",
      relationship: { kind: "handoff", sourceSessionId: "host/provider/source", strategy: "summary_bootstrap" },
      pending: true,
      summary: "A bounded handoff summary.",
    }, {
      sessionId: "host/provider/branch",
      relationship: { kind: "branch", sourceSessionId: "host/provider/source", strategy: "transcript_bootstrap" },
      pending: true,
      paused: true,
      bootstrap: "[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]",
      copiedMessages: [{
        id: "provider/message",
        sessionId: "host/provider/source",
        providerMessageId: "message",
        role: "assistant",
        createdAt: "2026-08-14T10:00:00.000Z",
        parts: [{ type: "text", text: "Visible copied context" }],
        status: "completed",
        nativeMetadata: {},
      }],
    }, {
      sessionId: "host/provider/side-chat",
      relationship: { kind: "side_chat", sourceSessionId: "host/provider/source", strategy: "transcript_bootstrap" },
      pending: true,
      bootstrap: "[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]",
      copiedMessages: [],
      sideChatPreview: "Why did this task choose that architecture?",
    }]);
    await store.flush();

    const restored = await new SessionTransferStateStore(path).read();
    assert.equal(restored.transfers.length, 3);
    assert.equal(restored.transfers[0]?.summary, "A bounded handoff summary.");
    assert.equal(restored.transfers[1]?.copiedMessages?.[0]?.parts[0]?.type, "text");
    assert.equal(restored.transfers[1]?.paused, true);
    assert.equal(restored.transfers[2]?.relationship.kind, "side_chat");
    assert.equal(restored.transfers[2]?.sideChatPreview, "Why did this task choose that architecture?");
    assert.match(await readFile(path, "utf8"), /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
