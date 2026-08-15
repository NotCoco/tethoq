import { randomUUID } from "node:crypto";
import { parseConnectorManifest, serveConnector, } from "@tethoq/connector-sdk";
const manifest = parseConnectorManifest({
    manifestVersion: 1,
    id: "community.echo",
    name: "Echo Connector",
    version: "0.1.0",
    runtime: { transport: "stdio-jsonl", command: "node", args: ["./connector.js"] },
    permissions: { filesystem: "none", network: false, spawnProcesses: false },
    capabilities: {
        listSessions: true,
        sessionHistory: true,
        createSession: true,
        sendMessage: true,
        streamingText: true,
        modelEnumeration: true,
        projectAssociation: true,
        reasoningEfforts: true,
    },
    models: [
        { id: "echo-fast", displayName: "Echo Fast", isDefault: true, reasoningEfforts: ["low", "medium"] },
        { id: "echo-careful", displayName: "Echo Careful", isDefault: false, reasoningEfforts: ["medium", "high"] },
    ],
});
const sessions = new Map();
const messages = new Map();
const subscriptions = new Map();
const server = serveConnector({
    manifest,
    handlers: {
        detect: () => ({ available: true, version: manifest.version, executable: process.execPath, details: ["Echo connector is ready"] }),
        getAuthStatus: () => ({ authenticated: true, canAuthenticate: false, method: "none", details: [] }),
        listSessions: () => ({ sessions: [...sessions.values()], nextCursor: null }),
        getSession: ({ sessionId }) => requireSession(sessionId),
        listMessages: ({ sessionId }) => [...(messages.get(requireSession(sessionId).id) ?? [])],
        createSession: (options) => {
            const now = new Date().toISOString();
            const project = options.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1);
            const session = {
                id: `echo_${randomUUID()}`,
                title: options.title ?? options.firstInstruction?.slice(0, 72) ?? "New echo task",
                workingDirectory: options.workingDirectory,
                ...(project !== undefined ? { project } : {}),
                state: "idle",
                createdAt: now,
                lastActivityAt: now,
                modelId: options.modelId ?? "echo-fast",
                ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
                needsApproval: false,
            };
            sessions.set(session.id, session);
            messages.set(session.id, []);
            return session;
        },
        sendMessage: async (request, context) => {
            const session = requireSession(request.sessionId);
            const now = new Date().toISOString();
            const assistantId = `message_${randomUUID()}`;
            const reply = `Echo: ${request.content}`;
            messages.get(session.id)?.push({
                id: request.requestId,
                sessionId: session.id,
                role: "user",
                createdAt: now,
                completedAt: now,
                parts: [{ type: "text", text: request.content }],
                status: "completed",
            });
            await broadcast(context.emitEvent, { id: randomUUID(), sessionId: session.id, type: "message.started", occurredAt: now, payload: { messageId: assistantId } });
            await broadcast(context.emitEvent, { id: randomUUID(), sessionId: session.id, type: "message.delta", occurredAt: now, payload: { messageId: assistantId, text: reply } });
            messages.get(session.id)?.push({ id: assistantId, sessionId: session.id, role: "assistant", createdAt: now, completedAt: now, parts: [{ type: "text", text: reply }], status: "completed" });
            await broadcast(context.emitEvent, { id: randomUUID(), sessionId: session.id, type: "message.completed", occurredAt: now, payload: { messageId: assistantId } });
            sessions.set(session.id, { ...session, state: "completed", lastActivityAt: now, preview: reply });
            await broadcast(context.emitEvent, { id: randomUUID(), sessionId: session.id, type: "agent.completed", occurredAt: now, payload: {} });
            return { accepted: true, turnId: assistantId, details: [] };
        },
        subscribe: ({ sessionId }) => {
            const subscriptionId = `subscription_${randomUUID()}`;
            subscriptions.set(subscriptionId, sessionId);
            return { subscriptionId };
        },
        unsubscribe: ({ subscriptionId }) => { subscriptions.delete(subscriptionId); },
    },
});
function requireSession(id) {
    const session = sessions.get(id);
    if (session === undefined)
        throw new Error(`Unknown session ${id}`);
    return session;
}
async function broadcast(emit, event) {
    await Promise.all([...subscriptions].filter(([, sessionId]) => sessionId === null || sessionId === event.sessionId).map(([id]) => emit(id, event)));
}
process.once("SIGTERM", () => void server.close());
process.once("SIGINT", () => void server.close());
