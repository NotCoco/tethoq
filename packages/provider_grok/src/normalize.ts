import { basename } from "node:path";
import {
  makeGlobalSessionId,
  makeProviderMessageId,
  type ContentPart,
  type JsonObject,
  type RemoteMessage,
  type RemoteSession,
  type SessionState,
} from "../../protocol/src/index.js";
import { providerPromptWorkflows, stripProviderPromptGuidance } from "../../provider_contract/src/index.js";

export interface AcpProviderIdentity {
  readonly providerId: string;
  readonly displayName: string;
  readonly sessionLabel?: string;
}

export const GROK_ACP_IDENTITY: AcpProviderIdentity = {
  providerId: "grok",
  displayName: "Grok Build",
  sessionLabel: "Grok",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function parseTimestamp(value: unknown, fallback: Date): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  return fallback.toISOString();
}

function sessionState(value: Record<string, unknown>): SessionState {
  const status = value.status;
  const type = typeof status === "string" ? status : isRecord(status) && typeof status.type === "string" ? status.type : "unknown";
  if (type === "idle") return "idle";
  if (type === "active" || type === "busy" || type === "retry") return "working";
  if (type === "completed" || type === "complete" || type === "success" || type === "succeeded") return "completed";
  if (type === "systemError" || type === "error" || type === "failed") return "failed";
  return "unknown";
}

export function normalizeAcpSession(
  hostId: string,
  value: unknown,
  now = new Date(),
  identity: AcpProviderIdentity = GROK_ACP_IDENTITY,
): RemoteSession {
  if (!isRecord(value)) throw new Error("ACP session payload is not an object");
  const providerSessionId = [value.sessionId, value.id].find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (providerSessionId === undefined) throw new Error("ACP session payload has no sessionId");
  const cwd = typeof value.cwd === "string" ? value.cwd : typeof value.workingDirectory === "string" ? value.workingDirectory : undefined;
  const title = typeof value.title === "string" && value.title.trim().length > 0
    ? stripProviderPromptGuidance(value.title)
    : `Untitled ${identity.sessionLabel ?? identity.displayName} session`;
  const updatedAt = parseTimestamp(value.updatedAt ?? value.lastActivityAt, now);
  const modelId = firstString(value, ["modelId", "model_id", "model"]);
  const reasoningEffort = firstString(value, ["reasoningEffort", "reasoning_effort", "thoughtLevel", "thought_level"]);
  return {
    id: makeGlobalSessionId(hostId, identity.providerId, providerSessionId),
    hostId,
    providerId: identity.providerId,
    providerSessionId,
    title,
    ...(cwd !== undefined ? { workingDirectory: cwd, project: basename(cwd) || cwd } : {}),
    state: sessionState(value),
    lastActivityAt: updatedAt,
    preview: typeof value.preview === "string" ? stripProviderPromptGuidance(value.preview) : title,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    needsApproval: false,
    stale: false,
    nativeMetadata: asJsonObject(value),
  };
}

export interface AcpMessageAccumulator {
  readonly messages: Map<string, RemoteMessage>;
  readonly orderedIds: string[];
}

type SubagentPart = Extract<ContentPart, { readonly type: "subagent" }>;

export function createMessageAccumulator(): AcpMessageAccumulator {
  return { messages: new Map<string, RemoteMessage>(), orderedIds: [] };
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

export function acpSubagentChildSessionId(update: Record<string, unknown>): string | undefined {
  return firstString(update, ["child_session_id", "childSessionId"]);
}

export const grokSubagentChildSessionId = acpSubagentChildSessionId;

function grokSubagentStatus(value: unknown): SubagentPart["status"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (["pending", "queued"].includes(normalized)) return "pending";
  if (["running", "active", "started", "in_progress"].includes(normalized)) return "running";
  if (["completed", "complete", "success", "succeeded"].includes(normalized)) return "completed";
  if (["failed", "error", "cancelled", "canceled", "interrupted", "stopped", "killed"].includes(normalized)) return "failed";
  return "unknown";
}

export function normalizeAcpSubagentUpdate(
  update: Record<string, unknown>,
  receiverSessionIds: readonly string[] = [],
): SubagentPart | null {
  const sessionUpdate = firstString(update, ["sessionUpdate", "session_update"]);
  if (sessionUpdate !== "subagent_spawned" && sessionUpdate !== "subagent_finished") return null;
  const summary = firstString(update, sessionUpdate === "subagent_finished"
    ? ["output", "error", "description"]
    : ["description", "summary"]);
  const prompt = firstString(update, ["prompt"]);
  const modelId = firstString(update, ["model", "modelId", "model_id"]);
  const reasoningEffort = firstString(update, ["reasoningEffort", "reasoning_effort"]);
  return {
    type: "subagent",
    tool: "spawn_subagent",
    action: "spawn",
    status: sessionUpdate === "subagent_spawned" ? "running" : grokSubagentStatus(update.status),
    receiverSessionIds,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

export const normalizeGrokSubagentUpdate = normalizeAcpSubagentUpdate;

export function appendAcpSubagentPart(
  hostId: string,
  providerSessionId: string,
  update: Record<string, unknown>,
  part: SubagentPart,
  accumulator: AcpMessageAccumulator,
  now = new Date(),
  identity: AcpProviderIdentity = GROK_ACP_IDENTITY,
): RemoteMessage {
  const lifecycleId = firstString(update, ["subagent_id", "subagentId", "child_session_id", "childSessionId"])
    ?? String(accumulator.orderedIds.length);
  const nativeId = `subagent_${lifecycleId}`;
  const existing = accumulator.messages.get(nativeId);
  const prior = existing?.parts.find((entry): entry is SubagentPart => entry.type === "subagent");
  const modelId = part.modelId ?? prior?.modelId;
  const reasoningEffort = part.reasoningEffort ?? prior?.reasoningEffort;
  const prompt = part.prompt ?? prior?.prompt;
  const summary = part.summary ?? prior?.summary;
  const mergedPart: SubagentPart = prior === undefined ? part : {
    ...prior,
    ...part,
    receiverSessionIds: part.receiverSessionIds.length > 0 ? part.receiverSessionIds : prior.receiverSessionIds,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
  const message: RemoteMessage = {
    id: makeProviderMessageId(identity.providerId, nativeId),
    sessionId: makeGlobalSessionId(hostId, identity.providerId, providerSessionId),
    providerMessageId: nativeId,
    role: "tool",
    createdAt: existing?.createdAt ?? now.toISOString(),
    parts: [mergedPart],
    status: "streaming",
    nativeMetadata: asJsonObject(update),
  };
  if (existing === undefined) accumulator.orderedIds.push(nativeId);
  accumulator.messages.set(nativeId, message);
  return message;
}

function thoughtText(source: Record<string, unknown>): string | undefined {
  for (const key of ["text", "thought", "thinking", "reasoning", "delta"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function acpContentLooksLikeThought(content: unknown): boolean {
  if (!isRecord(content)) return false;
  const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
  if (type === "thought" || type === "thinking" || type === "reasoning" || type === "agent_thought" || type === "thought_delta" || type === "reasoning_content") {
    return true;
  }
  return content.thought === true || content.isThought === true || content.isThinking === true;
}

export function acpUpdateLooksLikeThought(update: Record<string, unknown>, sessionUpdate: string): boolean {
  const name = sessionUpdate.toLowerCase();
  if (name.includes("thought") || name.includes("thinking") || name.includes("reason")) return true;
  if (update.thought === true || update.isThought === true || update.isThinking === true) return true;
  if (typeof update.thought === "string" || typeof update.thinking === "string" || typeof update.reasoning === "string") return true;
  return acpContentLooksLikeThought(update.content);
}

function textFromContent(content: unknown): { readonly part: ContentPart; readonly text: string } | null {
  if (typeof content === "string") return { part: { type: "text", text: content }, text: content };
  if (!isRecord(content)) return null;
  if (content.type === "image" && typeof content.uri === "string") return {
    part: { type: "image", uri: content.uri, ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}) },
    text: "",
  };
  const text = thoughtText(content);
  if (text !== undefined) return { part: { type: "text", text }, text };
  return null;
}

export function appendAcpContentChunk(
  hostId: string,
  providerSessionId: string,
  role: "user" | "assistant",
  update: Record<string, unknown>,
  accumulator: AcpMessageAccumulator,
  now = new Date(),
  retainAccumulatedText = true,
  fallbackMessageId?: string,
  partType: "text" | "reasoning" = "text",
  identity: AcpProviderIdentity = GROK_ACP_IDENTITY,
): RemoteMessage | null {
  const content = textFromContent(update.content) ?? (isRecord(update) ? textFromContent(update) : null);
  if (content === null) return null;
  const nativeId = typeof update.messageId === "string" && update.messageId.length > 0
    ? update.messageId
    : fallbackMessageId ?? `${role}_${accumulator.orderedIds.length}`;
  const existing = accumulator.messages.get(nativeId);
  const incomingWorkflows = role === "user" ? providerPromptWorkflows(content.text) : [];
  const incomingText = role === "user" ? stripProviderPromptGuidance(content.text) : content.text;
  const incomingPart = content.part.type === "text"
    ? { type: partType, text: incomingText, ...(partType === "reasoning" ? { redacted: false } : {}) } as ContentPart
    : content.part;
  const existingParts = retainAccumulatedText ? existing?.parts ?? [] : [];
  const parts = [...existingParts];
  const lastPartIndex = existingParts.length - 1;
  const prior = existingParts[lastPartIndex];
  if ((incomingPart.type === "text" || incomingPart.type === "reasoning") && prior?.type === incomingPart.type) {
    const priorText = prior?.type === incomingPart.type ? prior.text : "";
    const separator = /[a-z0-9][.!?:;]$/u.test(priorText) && /^[A-Z]/u.test(incomingPart.text) ? " " : "";
    parts[lastPartIndex] = { ...incomingPart, text: priorText + separator + incomingPart.text };
  } else {
    parts.push(incomingPart);
  }
  for (const workflow of incomingWorkflows) {
    if (!parts.some((part) => part.type === "workflow" && part.workflow.id === workflow.id)) parts.push({ type: "workflow", workflow });
  }
  const message: RemoteMessage = {
    id: makeProviderMessageId(identity.providerId, nativeId),
    sessionId: makeGlobalSessionId(hostId, identity.providerId, providerSessionId),
    providerMessageId: nativeId,
    role,
    createdAt: existing?.createdAt ?? now.toISOString(),
    parts,
    status: "streaming",
    nativeMetadata: asJsonObject(update),
  };
  if (existing === undefined) accumulator.orderedIds.push(nativeId);
  accumulator.messages.set(nativeId, message);
  return message;
}

export function completeAcpMessages(accumulator: AcpMessageAccumulator, now = new Date()): readonly RemoteMessage[] {
  return accumulator.orderedIds.map((id) => {
    const message = accumulator.messages.get(id);
    if (message === undefined) throw new Error(`Missing accumulated message ${id}`);
    return { ...message, completedAt: now.toISOString(), status: "completed" as const };
  });
}
