import { basename } from "node:path";
import {
  makeGlobalSessionId,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type RemoteMessage,
  type RemoteSession,
  type SessionState,
} from "../../protocol/src/index.js";
import type { CodexThread } from "./wire.js";
import { providerPromptWorkflows, stripProviderPromptGuidance } from "../../provider_contract/src/index.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function secondsToIso(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return new Date(value * 1_000).toISOString();
}

export function normalizeCodexStatus(status: unknown): SessionState {
  const type = typeof status === "string" ? status : isRecord(status) && typeof status.type === "string" ? status.type : "unknown";
  if (type === "idle") return "idle";
  if (type === "active" || type === "busy" || type === "retry") return "working";
  if (type === "systemError") return "failed";
  return "unknown";
}

export function normalizeCodexThread(hostId: string, thread: CodexThread): RemoteSession {
  const cwd = typeof thread.cwd === "string" ? thread.cwd : undefined;
  const name = typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : undefined;
  const parentThreadId = typeof thread.parentThreadId === "string" && thread.parentThreadId.trim() ? thread.parentThreadId.trim() : undefined;
  const forkedFromId = typeof thread.forkedFromId === "string" && thread.forkedFromId.trim() ? thread.forkedFromId.trim() : undefined;
  const agentNickname = typeof thread.agentNickname === "string" && thread.agentNickname.trim() ? thread.agentNickname.trim() : undefined;
  const agentRole = typeof thread.agentRole === "string" && thread.agentRole.trim() ? thread.agentRole.trim() : undefined;
  const modelId = typeof thread.model === "string" && thread.model.trim() ? thread.model.trim() : undefined;
  const reasoningEffort = typeof thread.effort === "string" && thread.effort.trim() ? thread.effort.trim() : undefined;
  const preview = typeof thread.preview === "string" ? stripProviderPromptGuidance(thread.preview) : "";
  const title = name ?? preview.split(/\r?\n/, 1)[0]?.trim().slice(0, 96) ?? "Codex thread";
  const updated = secondsToIso(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt);
  return {
    id: makeGlobalSessionId(hostId, "codex", thread.id),
    hostId,
    providerId: "codex",
    providerSessionId: thread.id,
    title: title || "Codex thread",
    ...(cwd !== undefined ? { workingDirectory: cwd, project: basename(cwd) || cwd } : {}),
    state: normalizeCodexStatus(thread.status),
    ...(typeof thread.createdAt === "number" ? { createdAt: secondsToIso(thread.createdAt) } : {}),
    lastActivityAt: updated,
    ...(preview ? { preview: preview.slice(0, 240) } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(parentThreadId !== undefined ? { parentSessionId: makeGlobalSessionId(hostId, "codex", parentThreadId) } : {}),
    ...(parentThreadId !== undefined ? {
      relationship: { kind: "subagent" as const, sourceSessionId: makeGlobalSessionId(hostId, "codex", parentThreadId), strategy: "native" as const },
    } : forkedFromId !== undefined ? {
      relationship: { kind: "branch" as const, sourceSessionId: makeGlobalSessionId(hostId, "codex", forkedFromId), strategy: "native" as const },
    } : {}),
    ...(agentNickname !== undefined ? { agentNickname } : {}),
    ...(agentRole !== undefined ? { agentRole } : {}),
    needsApproval: false,
    stale: false,
    nativeMetadata: jsonObject(thread),
  };
}

function textFromUnknown(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => textFromUnknown(entry, depth + 1)).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  for (const key of ["text", "content", "message", "output", "delta"]) {
    const candidate = textFromUnknown(value[key], depth + 1);
    if (candidate) return candidate;
  }
  return "";
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replaceAll("\\", "/").split("/").at(-1)?.trim();
  if (!candidate || candidate === "." || candidate === ".." || /[\u0000-\u001f]/.test(candidate)) return undefined;
  return candidate.slice(0, 255);
}

function imageMimeType(uri: string, explicit: unknown): string | undefined {
  if (typeof explicit === "string" && explicit.toLowerCase().startsWith("image/")) return explicit;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(uri);
  return match?.[1];
}

function safeImageUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(value) ? value : undefined;
}

function audioMimeType(uri: string, explicit: unknown): string | undefined {
  if (typeof explicit === "string" && explicit.toLowerCase().startsWith("audio/")) return explicit;
  const match = /^data:(audio\/[a-z0-9.+-]+);base64,/i.exec(uri);
  return match?.[1];
}

function safeAudioUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:data:audio\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(value) ? value : undefined;
}

function defaultAudioFilename(mimeType: string): string {
  if (mimeType.toLowerCase() === "audio/mpeg") return "Recording.mp3";
  if (mimeType.toLowerCase() === "audio/wav") return "Recording.wav";
  if (mimeType.toLowerCase() === "audio/mp4") return "Recording.m4a";
  return "Recording";
}

function wrapperFilename(text: string): string | undefined {
  const match = /^\s*<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)')[^>]*>\s*$/i.exec(text);
  return safeFilename(match?.[1] ?? match?.[2]);
}

function isClosingImageWrapper(text: string): boolean {
  return /^\s*<\/image>\s*$/i.test(text);
}

function stripSyntheticFileHeader(text: string): string {
  text = stripProviderPromptGuidance(text);
  const trimmedStart = text.trimStart();
  if (!/^# Files mentioned by the user:\s*\r?\n/.test(trimmedStart)) return text;
  const requestMarker = /^## My request:\s*\r?\n/m.exec(trimmedStart);
  if (requestMarker === null) return text;
  return trimmedStart.slice(requestMarker.index + requestMarker[0].length).trim();
}

/** Codex Desktop records its launch/bootstrap envelope as a user item before the real turn. */
export function isCodexBootstrapUserText(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<recommended_plugins>")
    && text.includes("# AGENTS.md instructions for ")
    && text.includes("<environment_context>");
}

export function codexUserContentParts(value: unknown): readonly ContentPart[] {
  const values = Array.isArray(value) ? value : [value];
  const parts: ContentPart[] = [];
  let pendingFilename: string | undefined;
  for (const value of values) {
    if (typeof value === "string") {
      const workflows = providerPromptWorkflows(value);
      const text = stripSyntheticFileHeader(value);
      if (text.trim()) parts.push({ type: "text", text });
      for (const workflow of workflows) parts.push({ type: "workflow", workflow });
      continue;
    }
    if (!isRecord(value)) continue;
    const type = typeof value.type === "string" ? value.type : "";
    if ((type === "text" || type === "input_text") && typeof value.text === "string") {
      const wrapperName = wrapperFilename(value.text);
      if (wrapperName !== undefined) {
        pendingFilename = wrapperName;
        continue;
      }
      if (isClosingImageWrapper(value.text)) {
        pendingFilename = undefined;
        continue;
      }
      const workflows = providerPromptWorkflows(value.text);
      const text = stripSyntheticFileHeader(value.text);
      if (text.trim()) parts.push({ type: "text", text });
      for (const workflow of workflows) parts.push({ type: "workflow", workflow });
      continue;
    }
    if (type === "image" || type === "input_image") {
      const rawUri = value.image_url ?? value.imageUrl ?? value.url ?? value.uri;
      const uri = safeImageUri(rawUri);
      const name = safeFilename(value.filename ?? value.fileName ?? value.name) ?? pendingFilename;
      const mimeType = imageMimeType(uri ?? "", value.mimeType ?? value.mime);
      parts.push({
        type: "image",
        ...(uri !== undefined ? { uri } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(name !== undefined ? { name } : {}),
      });
      pendingFilename = undefined;
      continue;
    }
    if (type === "audio" || type === "input_audio") {
      const rawUri = value.audio_url ?? value.audioUrl ?? value.url ?? value.uri;
      const uri = safeAudioUri(rawUri);
      const mimeType = audioMimeType(uri ?? "", value.mimeType ?? value.mime);
      if (uri !== undefined && mimeType !== undefined) {
        parts.push({
          type: "audio",
          uri,
          mimeType,
          name: safeFilename(value.filename ?? value.fileName ?? value.name) ?? defaultAudioFilename(mimeType),
          ...(typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0
            ? { durationSeconds: value.durationSeconds }
            : {}),
        });
      }
      pendingFilename = undefined;
    }
  }
  return parts;
}

function toolStatus(value: unknown): "pending" | "running" | "completed" | "failed" {
  if (typeof value !== "string") return "completed";
  if (value === "inProgress") return "running";
  if (value === "failed") return "failed";
  if (value === "pending") return "pending";
  return "completed";
}

function commandStatus(value: unknown): "pending" | "running" | "completed" | "failed" {
  if (typeof value !== "string") return "completed";
  if (value === "inProgress") return "running";
  if (value === "failed" || value === "declined") return "failed";
  if (value === "pending") return "pending";
  return "completed";
}

function changePaths(item: Record<string, unknown>): readonly string[] {
  const paths: string[] = [];
  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const change of changes) {
    if (typeof change === "string") paths.push(change);
    else if (isRecord(change) && typeof change.path === "string") paths.push(change.path);
  }
  if (paths.length === 0 && typeof item.path === "string") paths.push(item.path);
  return paths;
}

function subagentAction(tool: string): "spawn" | "message" | "wait" | "interrupt" | "list" | "unknown" {
  const normalized = tool.replaceAll(/[^a-z]/gi, "").toLowerCase();
  if (normalized === "spawnagent") return "spawn";
  if (normalized === "sendmessage" || normalized === "sendinput" || normalized === "followuptask") return "message";
  if (normalized === "wait" || normalized === "waitagent") return "wait";
  if (normalized === "interruptagent") return "interrupt";
  if (normalized === "listagents") return "list";
  return "unknown";
}

function subagentStatus(item: Record<string, unknown>): "pending" | "running" | "completed" | "failed" | "unknown" {
  const direct = canonicalSubagentStatus(item.status);
  if (direct !== "unknown") return direct;
  if (!isRecord(item.agentsStates)) return "unknown";
  const statuses = Object.values(item.agentsStates)
    .filter(isRecord)
    .map((state) => canonicalSubagentStatus(state.status));
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
  if (statuses.includes("pending")) return "pending";
  return "unknown";
}

function canonicalSubagentStatus(value: unknown): "pending" | "running" | "completed" | "failed" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const normalized = value.replaceAll(/[^a-z]/gi, "").toLowerCase();
  if (normalized === "pending" || normalized === "queued") return "pending";
  if (normalized === "running" || normalized === "inprogress") return "running";
  if (normalized === "completed" || normalized === "succeeded" || normalized === "success") return "completed";
  if (normalized === "failed" || normalized === "cancelled" || normalized === "canceled" || normalized === "declined") return "failed";
  return "unknown";
}

function safeSubagentText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!text || /(?:[a-z]:[\\/]|(?:^|\s)[\\/]{1,2}\S)/i.test(text)) return undefined;
  return text.slice(0, maximumLength);
}

function subagentSummary(item: Record<string, unknown>, receiverThreadIds: readonly string[]): string | undefined {
  if (!isRecord(item.agentsStates)) return undefined;
  for (const threadId of receiverThreadIds) {
    const state = item.agentsStates[threadId];
    if (!isRecord(state)) continue;
    const message = safeSubagentText(state.message, 240);
    if (message !== undefined) return message;
  }
  return undefined;
}

function subagentPart(hostId: string, item: Record<string, unknown>): ContentPart {
  const tool = typeof item.tool === "string" && item.tool.trim() ? item.tool.trim() : "unknown";
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? [...new Set(item.receiverThreadIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean))]
    : [];
  const modelId = typeof item.model === "string" && item.model.trim() ? item.model.trim() : undefined;
  const reasoningEffort = typeof item.reasoningEffort === "string" && item.reasoningEffort.trim() ? item.reasoningEffort.trim() : undefined;
  const prompt = safeSubagentText(item.prompt, 500);
  const summary = subagentSummary(item, receiverThreadIds);
  return {
    type: "subagent",
    tool,
    action: subagentAction(tool),
    status: subagentStatus(item),
    receiverSessionIds: receiverThreadIds.map((threadId) => makeGlobalSessionId(hostId, "codex", threadId)),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function contentParts(hostId: string, item: Record<string, unknown>): readonly ContentPart[] {
  const type = typeof item.type === "string" ? item.type : "unknown";
  if (type === "userMessage") {
    const parts = codexUserContentParts(item.content ?? item.text);
    const text = parts.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
    return isCodexBootstrapUserText(text) ? [] : parts;
  }
  if (type === "agentMessage" || type === "plan") {
    const text = textFromUnknown(item.content ?? item.text);
    return text ? [{ type: "text", text }] : [];
  }
  if (type === "reasoning") {
    const text = textFromUnknown(item.summary ?? item.content ?? item.text);
    return [text ? { type: "reasoning", text, redacted: false } : { type: "reasoning", text: "Reasoning was not exposed by the provider.", redacted: true }];
  }
  if (type === "commandExecution") {
    const command = textFromUnknown(item.command) || "command";
    return [{
      type: "command",
      command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(textFromUnknown(item.aggregatedOutput ?? item.output) ? { output: textFromUnknown(item.aggregatedOutput ?? item.output) } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      status: commandStatus(item.status),
    }];
  }
  if (type === "fileChange") {
    const paths = changePaths(item);
    return [{
      type: "file_change",
      path: paths[0] ?? "unknown",
      ...(typeof item.patch === "string" ? { patch: item.patch } : {}),
      ...(paths.length > 1 ? { additionalPaths: paths.slice(1) } : {}),
      change: "unknown",
    }];
  }
  if (type === "collabAgentToolCall") return [subagentPart(hostId, item)];
  if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
    const name = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : type === "webSearch" ? "webSearch" : type;
    const output = type === "webSearch"
      ? Array.isArray(item.results) && item.results.length > 0 ? JSON.stringify(item.results).slice(0, 2_000) : ""
      : textFromUnknown(item.result ?? item.contentItems ?? item.output);
    return [{
      type: "tool",
      name,
      ...(typeof item.id === "string" ? { callId: item.id } : {}),
      ...(isJsonValue(item.arguments) ? { input: item.arguments } : type === "webSearch" && typeof item.query === "string" ? { input: { query: item.query } } : {}),
      ...(output ? { output } : {}),
      status: toolStatus(item.status),
    }];
  }
  if (type === "contextCompaction") return [{ type: "text", text: "Session compacted" }];
  // Codex may add structured item kinds before this client knows how to
  // present them. Do not flatten an unknown object into assistant prose: it
  // can contain an entire browser snapshot, command trace, or provider
  // envelope. Known conversational and activity kinds are handled above.
  return [];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function messagesFromCodexThread(hostId: string, thread: CodexThread): readonly RemoteMessage[] {
  const sessionId = makeGlobalSessionId(hostId, "codex", thread.id);
  const result: RemoteMessage[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let sequence = 0;
  for (const turn of turns) {
    if (!isRecord(turn)) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of items) {
      if (!isRecord(itemValue)) continue;
      const parts = contentParts(hostId, itemValue);
      if (parts.length === 0) continue;
      const nativeId = typeof itemValue.id === "string" ? itemValue.id : `item_${sequence}`;
      const type = typeof itemValue.type === "string" ? itemValue.type : "";
      const role = type === "userMessage" ? "user" : type === "commandExecution" || type === "webSearch" || type.includes("Tool") ? "tool" : "assistant";
      const createdAt = secondsToIso(itemValue.createdAt ?? turn.createdAt ?? thread.createdAt);
      result.push({
        id: `codex/${nativeId}`,
        sessionId,
        providerMessageId: nativeId,
        role,
        createdAt,
        completedAt: createdAt,
        parts,
        status: "completed",
        ...(type === "userMessage" && isPlainTextUserMessageItem(itemValue, parts)
          ? { editable: true }
          : {}),
        nativeMetadata: jsonObject(itemValue),
      });
      sequence += 1;
    }
  }
  return result;
}

function isPlainTextUserMessageItem(item: Record<string, unknown>, parts: readonly ContentPart[]): boolean {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.length > 0 &&
    content.every((entry) => isRecord(entry) && (entry.type === "text" || entry.type === "input_text")) &&
    parts.length > 0 &&
    parts.every((part) => part.type === "text");
}
