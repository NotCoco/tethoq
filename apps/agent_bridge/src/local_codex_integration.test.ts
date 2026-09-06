import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  createDeviceIdentity,
  createHostIdentity,
  signDeviceAction,
  type JsonObject,
  type RequestEnvelope,
  type SignedCredential,
} from "../../../packages/protocol/src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../../packages/provider_codex/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { BridgeSocketServer } from "./transport.js";

/**
 * Opt-in real Codex end-to-end vertical slice through the Agent Bridge.
 *
 * Skipped unless TETHOQ_CODEX_INTEGRATION=1. Pairs a real device over a local
 * WebSocket, then runs provider.list -> sessions.refresh -> session.open ->
 * models.list against the installed Codex App Server. Structure assertions
 * only; no account content or prompt text is written to committed fixtures.
 *
 * Commands:
 *   $env:TETHOQ_CODEX_INTEGRATION="1"; npm run build; node --test dist/apps/agent_bridge/src/local_codex_integration.test.js
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MessageInbox {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<{ readonly predicate: (value: unknown) => boolean; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }> = [];
  public constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = text; }
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(value));
      if (index >= 0) {
        const waiter = this.#waiters.splice(index, 1)[0];
        if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve(value); }
      } else this.#values.push(value);
    });
  }
  public countWhere(predicate: (value: unknown) => boolean): number {
    return this.#values.filter(predicate).length;
  }
  public async nextWhere(predicate: (value: unknown) => boolean, timeoutMs = 30_000): Promise<unknown> {
    const index = this.#values.findIndex(predicate);
    if (index >= 0) return this.#values.splice(index, 1)[0];
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for bridge WebSocket message"));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

function request(hostId: string, type: string, requestId: string, payload: JsonObject): RequestEnvelope {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: randomUUID(),
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type,
    requestId,
    payload,
  };
}

function hasEventType(value: unknown, eventType: string): boolean {
  if (!isRecord(value) || value.kind !== "event") return false;
  if (value.type === eventType) return true;
  if (value.type === "event.batch" && isRecord(value.payload) && Array.isArray(value.payload.events)) {
    return value.payload.events.some((entry) => isRecord(entry) && entry.type === eventType);
  }
  return false;
}

function countEvents(inbox: MessageInbox, eventType: string): number {
  return inbox.countWhere((value) => hasEventType(value, eventType));
}
async function connect(url: string): Promise<{ readonly socket: WebSocket; readonly inbox: MessageInbox }> {
  const socket = new WebSocket(url);
  const inbox = new MessageInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to bridge")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Bridge connection failed")); }, { once: true });
  });
  return { socket, inbox };
}

test("Codex mesh installation keeps its transient CLI hidden on Windows", async () => {
  const source = await readFile(new URL("../../../../apps/agent_bridge/src/codex_tools.ts", import.meta.url), "utf8");
  const spawnStart = source.indexOf("const child = spawn(");
  const spawnEnd = source.indexOf("let stdout", spawnStart);
  assert.ok(spawnStart >= 0 && spawnEnd > spawnStart, "the Codex mesh installer spawn must remain identifiable");
  const spawnCall = source.slice(spawnStart, spawnEnd);
  assert.match(spawnCall, /windowsHide:\s*true/u);
  assert.match(spawnCall, /shell:\s*false/u);
});

test("real Codex end-to-end slice over the authenticated bridge socket (opt-in)", async (context) => {
  if ((process.env.TETHOQ_CODEX_INTEGRATION ?? process.env.UAR_CODEX_INTEGRATION) !== "1") {
    context.skip("set TETHOQ_CODEX_INTEGRATION=1 to run against the local Codex installation");
    return;
  }
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_local_codex",
    displayName: "Local Codex integration host",
    identity: createHostIdentity(),
    enabledProviders: ["codex"],
  };
  const codex = new CodexAdapter({
    hostId: config.hostId,
    ...((process.env.TETHOQ_CODEX_COMMAND ?? process.env.UAR_CODEX_COMMAND) !== undefined
      ? { command: (process.env.TETHOQ_CODEX_COMMAND ?? process.env.UAR_CODEX_COMMAND)! }
      : {}),
    requestTimeoutMs: 60_000,
  });
  const bridge = new AgentBridge(config, [codex]);
  await bridge.start();
  const pairing = bridge.startPairing();
  const server = new BridgeSocketServer(bridge, { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const connection = await connect(`ws://127.0.0.1:${address.port}/bridge`);
  context.after(async () => {
    connection.socket.close();
    await server.close();
    await bridge.dispose();
  });

  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  assert.equal(hello.hostId, config.hostId);

  const device = createDeviceIdentity("device_local_codex");
  const pairRequest = request(config.hostId, "pairing.confirm", "request_pair", {
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  connection.socket.send(JSON.stringify(pairRequest));
  const pairResponse = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "response" && value.requestId === "request_pair");
  assert.ok(isRecord(pairResponse) && pairResponse.ok === true && isRecord(pairResponse.payload));
  const credential: SignedCredential = {
    payload: String(pairResponse.payload.payload),
    signature: String(pairResponse.payload.signature),
  };

  async function signedRequest(type: string, requestId: string, payload: JsonObject): Promise<unknown> {
    const envelope = request(config.hostId, type, requestId, payload);
    const signed = signDeviceAction({
      credential,
      action: JSON.parse(JSON.stringify(envelope)) as JsonObject,
      devicePrivateKeyPem: device.privateKeyPem,
      actionId: `action_${requestId}_${randomUUID()}`,
    });
    connection.socket.send(JSON.stringify({ kind: "signed_action", signed }));
    return await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "response" && value.requestId === requestId);
  }

  const providers = await signedRequest("provider.list", "request_providers", {});
  assert.ok(isRecord(providers) && providers.ok === true && isRecord(providers.payload));
  const providerList = providers.payload.providers;
  assert.ok(Array.isArray(providerList));
  const codexEntry = providerList.find((entry) => isRecord(entry) && entry.providerId === "codex");
  assert.ok(isRecord(codexEntry), "codex provider must be listed");
  assert.equal(codexEntry.detected, true);
  console.log(`[e2e] provider.list codex: state=${codexEntry.state} authenticated=${codexEntry.authenticated} nativeVersion=${codexEntry.nativeVersion ?? "?"}`);

  const refresh = await signedRequest("sessions.refresh", "request_refresh", {});
  assert.ok(isRecord(refresh) && refresh.ok === true && isRecord(refresh.payload));
  const sessions = refresh.payload.sessions;
  assert.ok(Array.isArray(sessions));
  console.log(`[e2e] sessions.refresh returned ${sessions.length} sessions`);
  const codexSessions = sessions.filter((entry) => isRecord(entry) && entry.providerId === "codex");
  assert.ok(codexSessions.length > 0, "real Codex threads must be refreshed");

  const first = codexSessions[0];
  assert.ok(isRecord(first) && typeof first.id === "string" && typeof first.providerSessionId === "string");
  const opened = await signedRequest("session.open", "request_open", { sessionId: first.id });
  assert.ok(isRecord(opened) && opened.ok === true && isRecord(opened.payload));
  assert.ok(Array.isArray(opened.payload.messages));
  console.log(`[e2e] session.open normalized ${opened.payload.messages.length} messages for ${first.providerSessionId}`);

  const models = await signedRequest("models.list", "request_models", { providerId: "codex" });
  assert.ok(isRecord(models) && models.ok === true && isRecord(models.payload));
  assert.ok(Array.isArray(models.payload.models));
  console.log(`[e2e] models.list returned ${models.payload.models.length} models`);
  // Pin the default (cheapest, flash-class) model for the single test turn so a
  // pricier model is never used accidentally.
  const defaultModel = models.payload.models.find((entry) => isRecord(entry) && entry.isDefault === true && typeof entry.id === "string");
  const testModelId = isRecord(defaultModel) && typeof defaultModel.id === "string" ? defaultModel.id : undefined;
  console.log(`[e2e] pinned test model: ${testModelId ?? "default"}`);

  // ---- real send: one new instruction exactly once, then bridge-ledger idempotency ----
  const work = mkdtempSync(join(tmpdir(), "uar-e2e-"));
  const created = await signedRequest("session.create", "request_create", {
    providerId: "codex",
    workingDirectory: work,
    title: "UAR e2e probe",
    ...(testModelId !== undefined ? { modelId: testModelId } : {}),
  });
  assert.ok(isRecord(created) && created.ok === true && isRecord(created.payload));
  const createdSession = created.payload.session;
  assert.ok(isRecord(createdSession) && typeof createdSession.id === "string");
  const globalSessionId = createdSession.id;

  const sendRequestId = "e2e_send_once";

  const sent = await signedRequest("session.send_message", "request_send", {
    sessionId: globalSessionId,
    requestId: sendRequestId,
    content: "Reply with exactly the single token: TETHOQ_E2E_OK. Do not use any tools.",
    ...(testModelId !== undefined ? { modelId: testModelId } : {}),
  });
  assert.ok(isRecord(sent) && sent.ok === true && isRecord(sent.payload));
  console.log(`[e2e] session.send_message accepted turn=${JSON.stringify(sent.payload.providerTurnId ?? null)}`);

  // Wait for the completion event over the live socket.
  await connection.inbox.nextWhere((value) => hasEventType(value, "agent.completed"), 120_000);
  const deltasAfterSend = countEvents(connection.inbox, "message.delta");
  console.log(`[e2e] live events streamed; message.delta events so far=${deltasAfterSend}`);

  // Retry the identical request ID: bridge ledger must not start a second turn.
  const retried = await signedRequest("session.send_message", "request_send", {
    sessionId: globalSessionId,
    requestId: sendRequestId,
    content: "Reply with exactly the single token: TETHOQ_E2E_OK. Do not use any tools.",
    ...(testModelId !== undefined ? { modelId: testModelId } : {}),
  });
  assert.ok(isRecord(retried) && retried.ok === true && isRecord(retried.payload));
  const turnMatches = JSON.stringify(retried.payload.providerTurnId) === JSON.stringify(sent.payload.providerTurnId);
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const deltasAfterRetry = countEvents(connection.inbox, "message.delta");
  const completions = countEvents(connection.inbox, "agent.completed");
  console.log(`[e2e] retry same requestId: sameTurn=${turnMatches} deltas=${deltasAfterSend}->${deltasAfterRetry} completions=${completions}`);
  assert.ok(deltasAfterRetry === deltasAfterSend, "a retried request ID must not start a second Codex turn");
  assert.ok(turnMatches || completions <= 1, "retried send must not duplicate work");

  // Clean up the created test thread through the SAME app-server process that
  // created it (the bridge adapter). A different app-server process sees the
  // thread as "already has an active writer" while the owner is alive.
  try {
    const peer = await codex["peer"]();
    let deleted: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        deleted = await peer.request("thread/delete", { threadId: createdSession.providerSessionId });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    console.log(`[e2e] test thread deleted: ${JSON.stringify(deleted)}`);
  } catch (error) {
    console.warn(`[e2e] test thread cleanup failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("[e2e] real Codex bridge vertical slice complete (pair/refresh/open/models/send/idempotency)");
});
