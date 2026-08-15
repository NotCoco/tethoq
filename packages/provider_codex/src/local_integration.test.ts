import assert from "node:assert/strict";
import test from "node:test";
import { CodexAdapter } from "./codex_adapter.js";

/**
 * Opt-in real-provider integration test.
 *
 * Skipped unless TETHOQ_CODEX_INTEGRATION=1. Starts the installed Codex App
 * Server over stdio and exercises the documented vertical slice:
 * detect -> account/read -> model/list -> thread/list -> thread/read.
 * This test never writes account content, prompts, or transcript text to
 * committed fixtures; it asserts structure only and prints counts.
 *
 * Commands:
 *   $env:TETHOQ_CODEX_INTEGRATION="1"; npm run build; node --test dist/packages/provider_codex/src/local_integration.test.js
 */
test("real Codex App Server vertical slice (opt-in)", async (t) => {
  if ((process.env.TETHOQ_CODEX_INTEGRATION ?? process.env.UAR_CODEX_INTEGRATION) !== "1") {
    t.skip("set TETHOQ_CODEX_INTEGRATION=1 to run against the local Codex installation");
    return;
  }
  const adapter = new CodexAdapter({
    hostId: "local_integration_host",
    ...((process.env.TETHOQ_CODEX_COMMAND ?? process.env.UAR_CODEX_COMMAND) !== undefined
      ? { command: (process.env.TETHOQ_CODEX_COMMAND ?? process.env.UAR_CODEX_COMMAND)! }
      : {}),
    requestTimeoutMs: 60_000,
  });
  try {
    const detection = await adapter.detect();
    assert.equal(detection.available, true, `Codex must be installed (details: ${detection.details.join("; ")})`);
    console.log(`[integration] codex detect: ${detection.version ?? "unknown"} (${detection.details.join("; ")})`);

    const status = await adapter.getAuthStatus();
    console.log(`[integration] auth status: authenticated=${status.authenticated} canAuthenticate=${status.canAuthenticate} details=${status.details.join("; ")}`);

    const capabilities = await adapter.getCapabilities();
    assert.equal(capabilities.listSessions, true);

    const models = await adapter.listModels();
    assert.ok(Array.isArray(models));
    for (const model of models) {
      assert.ok(typeof model.id === "string" && model.id.length > 0);
      assert.ok(typeof model.displayName === "string" && model.displayName.length > 0);
    }
    console.log(`[integration] model/list returned ${models.length} models`);

    const listing = await adapter.listSessions({ limit: 5 });
    assert.ok(Array.isArray(listing.sessions));
    console.log(`[integration] thread/list returned ${listing.sessions.length} sessions (nextCursor=${listing.nextCursor ?? "null"})`);

    if (listing.sessions.length > 0) {
      const first = listing.sessions[0];
      const session = await adapter.getSession(first.providerSessionId);
      assert.equal(session.providerSessionId, first.providerSessionId);
      assert.equal(session.providerId, "codex");
      console.log(`[integration] thread/read OK for ${first.providerSessionId}: title=${JSON.stringify(session.title)} state=${session.state}`);

      const messages = await adapter.getMessages(first.providerSessionId);
      assert.ok(Array.isArray(messages));
      console.log(`[integration] thread history normalized ${messages.length} messages`);
    }

    const refresh = await adapter.listSessions({ limit: 5 });
    assert.equal(refresh.sessions.length, listing.sessions.length);
    console.log("[integration] vertical slice complete");
  } finally {
    await adapter.dispose();
  }
});
