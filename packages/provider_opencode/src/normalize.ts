import { basename } from "node:path";
import {
  makeGlobalSessionId,
  type ContentPart,
  type JsonObject,
  type RemoteMessage,
  type RemoteSession,
  type SessionState,
} from "../../protocol/src/index.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function milliseconds(value: unknown, fallback = Date.now()): string {
  return new Date(typeof value === "number" && Number.isFinite(value) ? value : fallback).toISOString();
}

export function normalizeOpenCodeSession(hostId: string, value: unknown, status?: unknown): RemoteSession {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("OpenCode session response is invalid");
  const time = isRecord(value.time) ? value.time : {};
  const cwd = typeof value.directory === "string" ? value.directory : undefined;
  const title = typeof value.title === "string" && value.title.trim() ? value.title : "OpenCode session";
  const parentProviderSessionId = typeof value.parentID === "string" && value.parentID.trim() ? value.parentID.trim() : undefined;
  const agentRole = typeof value.agent === "string" && value.agent.trim() ? value.agent.trim() : undefined;
  const modelId = openCodeModelId(value.model);
  const modelMetadata = isRecord(value.model) ? value.model : undefined;
  const rawVariant = typeof modelMetadata?.variant === "string" ? modelMetadata.variant : value.variant;
  const variantId = typeof rawVariant === "string" && rawVariant.trim() ? rawVariant.trim() : undefined;
  const state = normalizeStatus(status);
  return {
    id: makeGlobalSessionId(hostId, "opencode", value.id),
    hostId,
    providerId: "opencode",
    providerSessionId: value.id,
    title,
    ...(cwd !== undefined ? { workingDirectory: cwd, project: basename(cwd) || cwd } : {}),
    state,
    ...(typeof time.created === "number" ? { createdAt: milliseconds(time.created) } : {}),
    lastActivityAt: milliseconds(time.updated ?? time.created),
    preview: title,
    ...(parentProviderSessionId !== undefined ? { parentSessionId: makeGlobalSessionId(hostId, "opencode", parentProviderSessionId) } : {}),
    ...(parentProviderSessionId !== undefined ? {
      relationship: { kind: "subagent" as const, sourceSessionId: makeGlobalSessionId(hostId, "opencode", parentProviderSessionId), strategy: "native" as const },
    } : {}),
    ...(agentRole !== undefined ? { agentRole } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
    needsApproval: state === "needs_approval",
    stale: false,
    nativeMetadata: asJsonObject(value),
  };
}

function openCodeModelId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  const providerId = typeof value.providerID === "string" && value.providerID.trim() ? value.providerID.trim() : undefined;
  const modelId = typeof value.id === "string" && value.id.trim()
    ? value.id.trim()
    : typeof value.modelID === "string" && value.modelID.trim() ? value.modelID.trim() : undefined;
  if (providerId !== undefined && modelId !== undefined) return `${providerId}/${modelId}`;
  return modelId;
}

export function normalizeStatus(value: unknown): SessionState {
  const type = typeof value === "string" ? value : isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
  if (type === "active" || type === "busy" || type === "retry") return "working";
  if (type === "idle") return "idle";
  if (type === "error") return "failed";
  return "unknown";
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replaceAll("\\", "/").split("/").at(-1)?.trim();
  if (!candidate || candidate === "." || candidate === ".." || /[\u0000-\u001f]/.test(candidate)) return undefined;
  return candidate.slice(0, 255);
}

function safeImageUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(value) ? value : undefined;
}

function partFromOpenCode(value: unknown): ContentPart | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
  if (value.type === "reasoning" && typeof value.text === "string") return { type: "reasoning", text: value.text, redacted: false };
  if (value.type === "file") {
    const mimeType = typeof value.mime === "string" ? value.mime : typeof value.mimeType === "string" ? value.mimeType : undefined;
    const name = safeFilename(value.filename ?? value.fileName ?? value.name) ?? "File attachment";
    if (mimeType?.toLowerCase().startsWith("image/") === true) {
      const uri = safeImageUri(value.url ?? value.uri);
      return {
        type: "image",
        ...(uri !== undefined ? { uri } : {}),
        mimeType,
        name,
      };
    }
    return { type: "file", name, ...(mimeType !== undefined ? { mimeType } : {}) };
  }
  if (value.type === "patch") {
    const files = Array.isArray(value.files) ? value.files.filter((entry): entry is string => typeof entry === "string") : [];
    return { type: "file_change", path: files.join(", ") || "multiple files", ...(typeof value.hash === "string" ? { patch: value.hash } : {}), change: "modified" };
  }
  if (value.type === "tool") {
    const state = isRecord(value.state) ? value.state : {};
    const status = typeof state.status === "string" ? state.status : "pending";
    return {
      type: "tool",
      name: typeof value.tool === "string" ? value.tool : "tool",
      ...(typeof value.callID === "string" ? { callId: value.callID } : {}),
      ...(isRecord(state.input) ? { input: asJsonObject(state.input) } : {}),
      ...(typeof state.output === "string" ? { output: state.output } : {}),
      status: status === "running" ? "running" : status === "completed" ? "completed" : status === "error" ? "failed" : "pending",
    };
  }
  return null;
}

export function normalizeOpenCodeMessages(hostId: string, providerSessionId: string, value: unknown): readonly RemoteMessage[] {
  if (!Array.isArray(value)) return [];
  const sessionId = makeGlobalSessionId(hostId, "opencode", providerSessionId);
  const messages: RemoteMessage[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : entry;
    const partsValue = Array.isArray(entry.parts) ? entry.parts : [];
    const parts = partsValue.map(partFromOpenCode).filter((part): part is ContentPart => part !== null);
    const id = typeof info.id === "string" ? info.id : `message_${messages.length}`;
    const role = info.role === "user" ? "user" : info.role === "assistant" ? "assistant" : "tool";
    const time = isRecord(info.time) ? info.time : {};
    const createdAt = milliseconds(time.created);
    messages.push({
      id: `opencode/${id}`,
      sessionId,
      providerMessageId: id,
      role,
      createdAt,
      ...(typeof time.completed === "number" ? { completedAt: milliseconds(time.completed) } : {}),
      parts,
      status: info.error !== undefined ? "failed" : typeof time.completed === "number" || role === "user" ? "completed" : "streaming",
      nativeMetadata: asJsonObject(info),
    });
  }
  return messages;
}
