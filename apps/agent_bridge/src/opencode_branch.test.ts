import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type JsonObject, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { OpenCodeAdapter } from "../../../packages/provider_opencode/src/opencode_adapter.js";
import { AgentBridge } from "./bridge.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";

for (const ending of ["stop", "content-filter", "interrupted", "running", "tool-calls"] as const) {
  test(`OpenCode branch preserves the latest exchange and stays paused: ${ending}`, async (t) => {
    const hostId = `branch-${ending}`;
    const sourceId = makeGlobalSessionId(hostId, "opencode", "source");
    const rows: JsonObject[] = Array.from({ length: 504 }, (_, index) => ({
      info: { id: `msg_${String(index).padStart(4, "0")}`, sessionID: "source", role: index % 2 ? "assistant" : "user",
        ...(index % 2 ? { parentID: `msg_${String(index - 1).padStart(4, "0")}`, finish: "stop" } : {}),
        time: { created: 1000 + index, completed: 1001 + index }, providerID: "qa", modelID: "model" },
      parts: [{ id: `part_${index}`, type: "text", text: `Exchange message ${index}` }],
    }));
    const last = rows.at(-1)!.info as JsonObject;
    if (ending === "interrupted") last.error = { name: "MessageAbortedError", data: { message: "Stopped" } };
    else if (ending === "running") { delete (last.time as JsonObject).completed; delete last.finish; }
    else last.finish = ending;
    const before = structuredClone(rows);
    const histories = new Map<string, JsonObject[]>([["source", rows]]);
    const writes: string[] = [];
    const session = (id: string) => ({ id, directory: "C:/qa", title: id, time: { created: 1000, updated: 3000 } });
    const adapter = new OpenCodeAdapter({ hostId, directory: "C:/qa", fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/session/status") return Response.json(ending === "running" ? { source: { type: "busy" } } : {});
      const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      const id = match?.[1];
      const action = match?.[2];
      if (init?.method === "POST") {
        writes.push(url.pathname);
        assert.ok(url.pathname === "/session" || action === "fork", "branching sent a prompt, abort or other write");
        const body = JSON.parse(String(init.body)) as JsonObject;
        const childRows = action === "fork" ? structuredClone(rows) : [];
        assert.equal(body.messageID, undefined, "branching rewound to an older message");
        for (const row of childRows) (row.info as JsonObject).sessionID = "child";
        histories.set("child", childRows);
        return Response.json(session("child"));
      }
      if (id && !action) return Response.json(session(id));
      if (id && action === "message") {
        const messages = histories.get(id) ?? [];
        const limit = Number(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("before");
        const end = cursor === null ? messages.length : Number(cursor);
        const start = Math.max(0, end - limit);
        return Response.json(messages.slice(start, end), { headers: start > 0 ? { "x-next-cursor": String(start) } : {} });
      }
      return new Response("not found", { status: 404 });
    } });
    let transfers: readonly SessionTransferRecord[] = [];
    const bridge = new AgentBridge({ version: 1, hostId, displayName: "Branch QA", identity: createHostIdentity(), enabledProviders: ["opencode"] }, [adapter], {
      onSessionTransfersChange: (records) => { transfers = records; },
    });
    t.after(() => bridge.dispose());
    const branch = await bridge.branchSession(sourceId);
    assert.equal(branch.copiedMessageCount, 504);
    assert.equal(branch.strategy, ending === "stop" || ending === "content-filter" ? "native" : "transcript_bootstrap");
    assert.equal(branch.session.state, "idle");
    assert.equal(branch.session.nativeMetadata.tethoqUserStopped, true);
    assert.equal(transfers[0]?.paused, true);
    const copied: RemoteMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await bridge.openSession(branch.session.id, cursor);
      assert.equal(page.session.state, "idle");
      copied.push(...page.messages);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(copied.length, 504);
    assert.equal(new Set(copied.map((message) => message.id)).size, 504);
    assert.match(JSON.stringify(copied), /Exchange message 502/);
    assert.match(JSON.stringify(copied), /Exchange message 503/);
    assert.deepEqual(rows, before, "source conversation changed");
    assert.deepEqual(writes, [branch.strategy === "native" ? "/session/source/fork" : "/session"]);
  });
}
