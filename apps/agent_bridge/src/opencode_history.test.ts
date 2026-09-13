import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { OpenCodeAdapter } from "../../../packages/provider_opencode/src/opencode_adapter.js";
import { AgentBridge } from "./bridge.js";

test("OpenCode task opens, refreshes, and older pages use native cursors without bulk history reads", async (t) => {
  const hostId = "paged-opencode";
  const sessionId = "ses_history";
  const rows = Array.from({ length: 160 }, (_, index) => ({
    info: { id: `msg_${String(index).padStart(4, "0")}`, sessionID: sessionId, role: index % 2 ? "assistant" : "user",
      time: { created: 1000 + index, completed: 1001 + index }, providerID: "qa", modelID: "model" },
    parts: [{ id: `prt_${index}`, type: "text", text: `History message ${index}` }],
  }));
  const reads: Array<{ limit: number; before: string | null }> = [];
  const adapter = new OpenCodeAdapter({ hostId, fetch: async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/session/status") return Response.json({});
    if (url.pathname === `/session/${sessionId}`) return Response.json({
      id: sessionId, title: "Large OpenCode task", directory: "C:/qa", time: { created: 1000, updated: 2000 },
    });
    assert.equal(url.pathname, `/session/${sessionId}/message`);
    const limit = Number(url.searchParams.get("limit"));
    assert.ok(limit > 0 && limit <= 40, `Routine chat read requested ${limit} messages`);
    const before = url.searchParams.get("before");
    reads.push({ limit, before });
    const end = before === null ? rows.length : rows.findIndex((row) => `cursor/${row.info.id}` === before);
    assert.ok(end >= 0, "The provider's opaque cursor was changed");
    const start = Math.max(0, end - limit);
    return Response.json(rows.slice(start, end), {
      headers: start > 0 ? { "x-next-cursor": `cursor/${rows[start]!.info.id}` } : {},
    });
  } });
  const bridge = new AgentBridge({ version: 1, hostId, displayName: "QA", identity: createHostIdentity(), enabledProviders: ["opencode"] }, [adapter]);
  t.after(() => bridge.dispose());
  const globalId = makeGlobalSessionId(hostId, "opencode", sessionId);
  const first = await bridge.openSession(globalId);
  assert.equal(first.messages.length, 40);
  assert.equal(first.messages[0]?.providerMessageId, "msg_0120");
  assert.ok(first.nextCursor);
  assert.equal(reads.length, 1, "Opening launched a background full-history reconstruction");

  // New output cannot shift a native cursor into repeating or skipping history.
  rows.push({ info: { id: "msg_0160", sessionID: sessionId, role: "user", time: { created: 1160, completed: 1161 }, providerID: "qa", modelID: "model" }, parts: [{ id: "prt_160", type: "text", text: "New prompt" }] });
  const seen = new Set(first.messages.map((message) => message.providerMessageId));
  let cursor: string | null = first.nextCursor;
  while (cursor !== null) {
    const page = await bridge.openSession(globalId, cursor);
    assert.ok(page.messages.length > 0);
    for (const message of page.messages) {
      assert.equal(seen.has(message.providerMessageId), false, "Older paging duplicated a message");
      seen.add(message.providerMessageId);
    }
    cursor = page.nextCursor;
    assert.ok(reads.length <= 4, "Older paging failed to reach the beginning");
  }
  assert.equal(seen.size, 160);
  assert.equal(reads.length, 4);
  const refreshed = await bridge.openSession(globalId, undefined, 40, true);
  assert.equal(refreshed.messages.at(-1)?.providerMessageId, "msg_0160");
  assert.equal(reads.at(-1)?.before, null);
  assert.equal(reads.length, 5, "Refresh did more than one bounded native read");
});

test("OpenCode paging respects cursor exhaustion and propagates failures without a bulk fallback", async (t) => {
  let fail = false;
  let calls = 0;
  const adapter = new OpenCodeAdapter({ hostId: "empty-page", fetch: async (input) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.searchParams.get("limit"), "40");
    if (fail) return new Response(null, { status: 503 });
    return Response.json([], { headers: url.searchParams.has("before") ? {} : { "x-next-cursor": "opaque/older" } });
  } });
  t.after(() => adapter.dispose());
  const recent = await adapter.getRecentMessages("ses_empty");
  assert.deepEqual(recent, { messages: [], complete: false, olderCursor: "opaque/older" });
  const older = await adapter.getOlderMessages("ses_empty", recent.olderCursor!);
  assert.deepEqual(older, { messages: [], complete: true, pageOnly: true });
  fail = true;
  await assert.rejects(adapter.getRecentMessages("ses_empty"), { code: "HTTP_503" });
  assert.equal(calls, 3);
});
