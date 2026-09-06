import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteMessage, RemoteSession } from "../../../packages/protocol/src/index.js";
import {
  branchBootstrap,
  branchBootstrapWithUserRequest,
  clientVisibleBranchMessages,
  clientVisibleHandoffMessages,
  handoffBootstrap,
  handoffSummary,
  maximumHandoffSummaryWords,
  minimumHandoffSummaryWords,
  maximumBranchBootstrapBytes,
  persistableBranchMessages,
} from "./context_transfer.js";

const session: RemoteSession = {
  id: "host/codex/source",
  hostId: "host",
  providerId: "codex",
  providerSessionId: "source",
  title: "Fix checkout",
  workingDirectory: "C:\\repo",
  state: "idle",
  lastActivityAt: "2026-08-14T10:00:00.000Z",
  modelId: "gpt-test",
  reasoningEffort: "high",
  needsApproval: false,
  stale: false,
  nativeMetadata: {},
};

const messages: RemoteMessage[] = [{
  id: "host/codex/message-1",
  sessionId: session.id,
  providerMessageId: "message-1",
  role: "user",
  createdAt: "2026-08-14T09:00:00.000Z",
  status: "completed",
  parts: [{ type: "text", text: "Keep the existing checkout flow and fix the retry bug." }],
  nativeMetadata: {},
}, {
  id: "host/codex/message-2",
  sessionId: session.id,
  providerMessageId: "message-2",
  role: "assistant",
  createdAt: "2026-08-14T09:01:00.000Z",
  status: "completed",
  parts: [
    { type: "text", text: "The retry guard was updated and focused tests passed." },
    { type: "file_change", path: "src/checkout.ts", change: "modified" },
    { type: "reasoning", text: "private chain of thought", redacted: false },
    { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "proof.png" },
  ],
  nativeMetadata: {},
}];

test("handoff summaries are deterministic, bounded, and grounded in normalized history", () => {
  const first = handoffSummary(session, messages);
  const second = handoffSummary(session, messages);
  const words = first.match(/\S+/g)?.length ?? 0;
  assert.equal(first, second);
  assert.ok(words >= minimumHandoffSummaryWords);
  assert.ok(words <= maximumHandoffSummaryWords);
  assert.match(first, /retry bug/);
  assert.match(first, /src\/checkout\.ts/);
  assert.doesNotMatch(first, /private chain of thought/);
  assert.doesNotMatch(first, /AQID/);
  const bootstrap = handoffBootstrap(first, "Write the regression test.", "Keep the patch narrow.");
  assert.match(bootstrap, /Current user request:\n\[\[TETHOQ_CONTEXT_HANDOFF_USER_REQUEST_V1\]\]\nWrite the regression test\./);
  assert.match(bootstrap, /Continuation note captured when the handoff was created:\nKeep the patch narrow\./);

  const visible = clientVisibleHandoffMessages([{ ...messages[0]!, parts: [{ type: "text", text: bootstrap }] }]);
  assert.deepEqual(visible[0]?.parts, [{ type: "text", text: "Write the regression test." }]);
});

test("branch bootstrap carries every normalized message but omits private reasoning and binary image data", () => {
  const result = branchBootstrap(session, messages, "Continue independently.");
  assert.equal(result.copiedMessageCount, 2);
  assert.match(result.content, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
  assert.match(result.content, /Keep the existing checkout flow/);
  assert.ok(result.content.includes("src/checkout.ts"));
  assert.match(result.content, /Continue independently/);
  assert.doesNotMatch(result.content, /private chain of thought/);
  assert.doesNotMatch(result.content, /AQID/);

  const submitted = branchBootstrapWithUserRequest(result.content, "Run the focused check.");
  const visible = clientVisibleBranchMessages([{ ...messages[0]!, parts: [{ type: "text", text: submitted }] }]);
  assert.deepEqual(visible[0]?.parts, [{ type: "text", text: "Run the focused check." }]);
});

test("branch bootstrap compactly snapshots an oversized transcript instead of failing", () => {
  const oversized: RemoteMessage = {
    ...messages[0]!,
    parts: [{ type: "text", text: `Keep the existing checkout flow ${"x".repeat(1_300_000)}` }],
  };
  const result = branchBootstrap(session, [oversized, messages[1]!], "Continue independently.");
  const size = Buffer.byteLength(result.content, "utf8");
  assert.ok(size <= maximumBranchBootstrapBytes);
  assert.equal(result.copiedMessageCount, 2);
  assert.match(result.content, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
  assert.match(result.content, /bounded snapshot/);
  assert.match(result.content, /Keep the existing checkout flow|retry guard|Continue independently/);
  assert.doesNotMatch(result.content, /generic bootstrap limit/);
  assert.doesNotMatch(result.content, /normalized transcript is \d+ bytes/);
  assert.doesNotMatch(result.content, /private chain of thought/);
  assert.doesNotMatch(result.content, /AQID/);
});

test("branch copies redact parameterized and URL-safe data URIs from text fields", () => {
  const sensitive: RemoteMessage = {
    ...messages[0]!,
    parts: [{
      type: "text",
      text: "first data:image/png;charset=utf-8;base64,abc-_== second data:text/plain,private-payload",
    }],
  };
  const bootstrap = branchBootstrap(session, [sensitive]).content;
  assert.doesNotMatch(bootstrap, /abc-_==|private-payload/);
  assert.match(bootstrap, /data URI omitted/);
  const persisted = persistableBranchMessages([sensitive]);
  assert.doesNotMatch(JSON.stringify(persisted), /abc-_==|private-payload/);
});
