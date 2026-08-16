import assert from "node:assert/strict";
import test from "node:test";
import { makeGlobalSessionId, type ProviderCapabilities, type RemoteSession } from "../../protocol/src/index.js";
import { collectAllSessionPages, providerPromptContent, providerPromptWorkflows, stripProviderPromptGuidance, type AgentProviderAdapter, type PaginatedSessions } from "./index.js";

test("provider prompt fallback keeps developer guidance separable from visible history", () => {
  const prompt = providerPromptContent({ content: "Visible request", developerInstructions: "Hidden response guidance" });
  assert.match(prompt, /Hidden response guidance/u);
  assert.equal(stripProviderPromptGuidance(prompt), "Visible request");
  assert.equal(stripProviderPromptGuidance("Ordinary request"), "Ordinary request");
});

test("workflow guidance stays hidden while its display reference survives normalization", () => {
  const workflow = { id: "workflow-1", name: "Comment workflow", eventCount: 442, screenshotCount: 18, applications: ["Code.exe"], promptReference: "C:\\Users\\example\\workflow.json" };
  const prompt = providerPromptContent({ content: "Please review this workflow.", workflows: [workflow] });
  assert.match(prompt, /tethoq_workflow_attachments/u);
  assert.equal(stripProviderPromptGuidance(prompt), "Please review this workflow.");
  const { promptReference: _promptReference, ...visibleWorkflow } = workflow;
  assert.deepEqual(providerPromptWorkflows(prompt), [visibleWorkflow]);
});

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

test("provider adapters can expose an optional idle-resource release hook", async () => {
  let releases = 0;
  const adapter: AgentProviderAdapter = {
    ...pagedAdapter(),
    releaseIdleResources: async () => { releases += 1; },
  };

  await adapter.releaseIdleResources?.();
  assert.equal(releases, 1);
  assert.equal(pagedAdapter().releaseIdleResources, undefined);
});
