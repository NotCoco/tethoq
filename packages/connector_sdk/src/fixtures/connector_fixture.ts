import { parseConnectorManifest, serveConnector } from "../index.js";
import { randomUUID } from "node:crypto";
import type { ConnectorMessage, ConnectorSession } from "../types.js";

const manifest = parseConnectorManifest({
  manifestVersion: 1,
  id: "test.fixture",
  name: "Test Fixture",
  version: "1.0.0",
  runtime: { transport: "stdio-jsonl", command: process.execPath },
  permissions: { filesystem: "none", network: false, spawnProcesses: false },
  capabilities: { listSessions: true, sessionHistory: true, createSession: true, sendMessage: true, messageQueue: true, streamingText: true, modelEnumeration: true },
  models: [{ id: "fixture-model", displayName: "Fixture Model", isDefault: true }],
});

const server = serveConnector({
  manifest,
  handlers: {
    detect: () => ({ available: true, version: "1.0.0", details: [] }),
    getAuthStatus: () => ({ authenticated: true, canAuthenticate: false, details: [] }),
    listModels: () => {
      if (process.env.CONNECTOR_FIXTURE_MODE === "exit_on_models") {
        process.stderr.write("fixture stopped intentionally\n", () => process.exit(7));
        return new Promise<never>(() => undefined);
      }
      return manifest.models ?? [];
    },
    listSessions: () => ({ sessions: [...sessions.values()], nextCursor: null }),
    getSession: ({ sessionId }) => requireSession(sessionId),
    listMessages: ({ sessionId }) => [...(messages.get(requireSession(sessionId).id) ?? [])],
    createSession: (params) => {
      const now = new Date().toISOString();
      const session: ConnectorSession = { id: `fixture_${randomUUID()}`, title: params.title ?? "Fixture task", workingDirectory: params.workingDirectory, state: "idle", createdAt: now, lastActivityAt: now, modelId: params.modelId ?? "fixture-model", needsApproval: false };
      sessions.set(session.id, session);
      messages.set(session.id, []);
      return session;
    },
    sendMessage: async (params, context) => {
      const session = requireSession(params.sessionId);
      const now = new Date().toISOString();
      const assistantId = `assistant_${randomUUID()}`;
      messages.get(session.id)?.push({ id: params.requestId, sessionId: session.id, role: "user", createdAt: now, completedAt: now, parts: [{ type: "text", text: params.content }], status: "completed" });
      for (const [subscriptionId, subscribedSession] of subscriptions) {
        if (subscribedSession === null || subscribedSession === session.id) await context.emitEvent(subscriptionId, { id: randomUUID(), sessionId: session.id, type: "message.delta", occurredAt: now, payload: { messageId: assistantId, text: `Fixture: ${params.content}` } });
      }
      messages.get(session.id)?.push({ id: assistantId, sessionId: session.id, role: "assistant", createdAt: now, completedAt: now, parts: [{ type: "text", text: `Fixture: ${params.content}` }], status: "completed" });
      return { accepted: true, turnId: assistantId, details: [] };
    },
    subscribe: ({ sessionId }) => {
      const id = `subscription_${randomUUID()}`;
      subscriptions.set(id, sessionId);
      return { subscriptionId: id };
    },
    unsubscribe: ({ subscriptionId }) => { subscriptions.delete(subscriptionId); },
    listQueuedMessages: ({ sessionId }) => queued.filter((message) => sessionId === undefined || message.sessionId === sessionId),
  },
});

const sessions = new Map<string, ConnectorSession>();
const messages = new Map<string, ConnectorMessage[]>();
const subscriptions = new Map<string, string | null>();
const queued = [
  { id: "queued_one", sessionId: "session_one", content: "one", state: "queued" as const, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "queued_two", sessionId: "session_two", content: "two", state: "queued" as const, createdAt: "2026-01-01T00:00:01.000Z" },
];

function requireSession(id: string): ConnectorSession {
  const session = sessions.get(id);
  if (session === undefined) throw new Error(`Unknown fixture session ${id}`);
  return session;
}

process.once("SIGTERM", () => void server.close());
