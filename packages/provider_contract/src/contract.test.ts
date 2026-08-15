import assert from "node:assert/strict";
import test from "node:test";
import { makeGlobalSessionId, type ProviderCapabilities, type RemoteSession } from "../../protocol/src/index.js";
import { collectAllSessionPages, type AgentProviderAdapter, type PaginatedSessions } from "./index.js";

const capabilities: ProviderCapabilities = {
  authentication: false,
  listSessions: true,
  paginatedSessions: true,
  sessionHistory: false,
  createSession: false,
  resumeSession: false,
  sendMessage: false,
  steering: false,
  streamingText: false,
  toolEvents: false,
  commandEvents: false,
  fileChanges: false,
  approvals: false,
  userInput: false,
  interrupt: false,
  modelEnumeration: false,
  projectAssociation: false,
  sessionRelationships: false,
  messageEditing: false,
  remoteConnectivity: "none",
  notes: [],
};

function session(index: number): RemoteSession {
  return {
    id: makeGlobalSessionId("host", "pages", String(index)),
    hostId: "host",
    providerId: "pages",
    providerSessionId: String(index),
    title: `Session ${index}`,
    state: "idle",
    lastActivityAt: "2026-08-07T12:00:00Z",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  };
}

function pagedAdapter(repeatCursor = false): AgentProviderAdapter {
  return {
    providerId: "pages",
    displayName: "Pages",
    detect: async () => ({ providerId: "pages", available: true, details: [] }),
    getAuthStatus: async () => ({ authenticated: true, canAuthenticate: false, details: [] }),
    getCapabilities: async () => capabilities,
    listSessions: async (options): Promise<PaginatedSessions> => {
      const cursor = options?.cursor;
      if (cursor === undefined) return { sessions: [session(1), session(2)], nextCursor: "next" };
      return { sessions: [session(3)], nextCursor: repeatCursor ? "next" : null };
    },
    getSession: async () => { throw new Error("not used"); },
    getMessages: async () => [],
    createSession: async () => { throw new Error("not used"); },
    resumeSession: async () => undefined,
    sendMessage: async () => ({ accepted: false, details: [] }),
    subscribe: async () => ({ id: "sub", unsubscribe: async () => undefined }),
    dispose: async () => undefined,
  };
}

test("pagination helper retrieves the complete index", async () => {
  const result = await collectAllSessionPages(pagedAdapter(), { limit: 2 });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.sessions.map((item) => item.providerSessionId), ["1", "2", "3"]);
});

test("pagination helper rejects provider cursor loops", async () => {
  await assert.rejects(() => collectAllSessionPages(pagedAdapter(true)), /repeated pagination cursor/);
});
