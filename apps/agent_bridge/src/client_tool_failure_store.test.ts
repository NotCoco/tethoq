import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import {
  BridgeOwnedClientToolFailureStore,
  durableClientToolCallId,
  maximumBridgeOwnedClientToolFailureSessions,
  maximumBridgeOwnedClientToolFailuresPerSession,
  type PersistedBridgeOwnedClientToolFailure,
} from "./client_tool_failure_store.js";

test("Bridge-owned client-tool failures persist only sanitized bounded correlation state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-client-tool-failure-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "client-tool-failures.json");
  const hostId = "host-client-tool-failures";
  const failures: Record<string, readonly PersistedBridgeOwnedClientToolFailure[]> = {};
  const unsafeCallId = "https://provider.invalid/private/C:\\secret\\eyes";
  const opaqueCallId = durableClientToolCallId(unsafeCallId)!;
  assert.match(opaqueCallId, /^tethoq-call-[a-f0-9]{40}$/u);

  for (let sessionIndex = 0; sessionIndex < maximumBridgeOwnedClientToolFailureSessions + 2; sessionIndex += 1) {
    const sessionId = makeGlobalSessionId(hostId, "connector", `session-${sessionIndex}`);
    failures[sessionId] = Array.from(
      { length: maximumBridgeOwnedClientToolFailuresPerSession + 2 },
      (_, failureIndex) => ({
        callId: failureIndex === maximumBridgeOwnedClientToolFailuresPerSession + 1
          ? opaqueCallId
          : failureIndex === maximumBridgeOwnedClientToolFailuresPerSession
            ? `call-${sessionIndex}-1`
          : `call-${sessionIndex}-${failureIndex}`,
        occurredAt: new Date(Date.UTC(2026, 7, 28, 10, sessionIndex % 60, failureIndex % 60)).toISOString(),
        failureKind: failureIndex % 2 === 0 ? "usage" as const : "auth" as const,
        rawError: "429 api_key=sk-private-do-not-store",
        prompt: "Describe the private image",
        path: "C:\\private\\eyes.png",
        url: "https://provider.invalid/secret",
      })) as readonly PersistedBridgeOwnedClientToolFailure[];
  }
  failures[makeGlobalSessionId("foreign-host", "connector", "foreign")] = [{
    callId: "foreign-call",
    occurredAt: "2026-08-28T10:00:00.000Z",
    failureKind: "unknown",
  }];

  const store = new BridgeOwnedClientToolFailureStore(path, hostId);
  await store.scheduleWrite(failures);
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /sk-private|Describe the private image|private\\eyes|provider\.invalid/u);

  const restored = await new BridgeOwnedClientToolFailureStore(path, hostId).read();
  assert.equal(Object.keys(restored.failures).length, maximumBridgeOwnedClientToolFailureSessions);
  assert.equal(restored.failures[makeGlobalSessionId(hostId, "connector", "session-0")], undefined);
  const newest = restored.failures[makeGlobalSessionId(
    hostId,
    "connector",
    `session-${maximumBridgeOwnedClientToolFailureSessions + 1}`,
  )]!;
  assert.equal(newest.length, maximumBridgeOwnedClientToolFailuresPerSession);
  assert.equal(newest.at(-1)?.callId, opaqueCallId);
  assert.equal(newest.find((failure) => failure.callId.endsWith("-1"))?.failureKind, "usage");
  assert.deepEqual(Object.keys(newest.at(-1)!).sort(), ["callId", "failureKind", "occurredAt"]);
});
