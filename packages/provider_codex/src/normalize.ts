import { basename } from "node:path";
import {
  makeGlobalSessionId,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type RemoteMessage,
  type RemoteMessageOrigin,
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
  const normalizedName = typeof thread.name === "string" ? normalizedCodexUserText(thread.name) : undefined;
  const name = normalizeCodexThreadName(thread.name);
  const parentThreadId = typeof thread.parentThreadId === "string" && thread.parentThreadId.trim() ? thread.parentThreadId.trim() : undefined;
  const forkedFromId = typeof thread.forkedFromId === "string" && thread.forkedFromId.trim() ? thread.forkedFromId.trim() : undefined;
  const agentNickname = typeof thread.agentNickname === "string" && thread.agentNickname.trim() ? thread.agentNickname.trim() : undefined;
  const agentRole = typeof thread.agentRole === "string" && thread.agentRole.trim() ? thread.agentRole.trim() : undefined;
  const modelId = typeof thread.model === "string" && thread.model.trim() ? thread.model.trim() : undefined;
  const reasoningEffort = typeof thread.effort === "string" && thread.effort.trim() ? thread.effort.trim() : undefined;
  const normalizedPreview = typeof thread.preview === "string" ? normalizedCodexUserText(thread.preview) : undefined;
  const preview = normalizedPreview?.text.trim() ?? "";
  const realtimeVoice = normalizedName?.realtimeVoice === true || normalizedPreview?.realtimeVoice === true;
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
    nativeMetadata: sanitizedThreadMetadata(thread, title || "Codex thread", preview, realtimeVoice),
  };
}

function sanitizedThreadMetadata(thread: CodexThread, title: string, preview: string, realtimeVoice = false): JsonObject {
  // `thread/list` may include a thread's complete `turns` array. Cloning the
  // provider object here retained every historical message a second time inside
  // the session catalogue, even though no session consumer reads that history
  // from nativeMetadata. Keep only bounded diagnostic scalars; transcript data
  // is loaded progressively through the dedicated history path.
  const scalar = (value: unknown, maximumLength: number): string | undefined =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim().slice(0, maximumLength)
      : undefined;
  const metadata: JsonObject = { name: title };
  if (preview) metadata.preview = preview;
  const sessionId = scalar(thread.sessionId, 256);
  const modelProvider = scalar(thread.modelProvider, 256);
  const cliVersion = scalar(thread.cliVersion, 128);
  const historyMode = scalar(thread.historyMode, 64);
  if (sessionId !== undefined) metadata.sessionId = sessionId;
  if (modelProvider !== undefined) metadata.modelProvider = modelProvider;
  if (cliVersion !== undefined) metadata.cliVersion = cliVersion;
  if (historyMode !== undefined) metadata.historyMode = historyMode;
  if (typeof thread.ephemeral === "boolean") metadata.ephemeral = thread.ephemeral;
  if (typeof thread.canAcceptDirectInput === "boolean") metadata.canAcceptDirectInput = thread.canAcceptDirectInput;
  if (realtimeVoice) metadata.tethoqRealtimeVoice = true;
  return metadata;
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

const codexResponseAnnotationDirective = /:codex-annotation\{index="[1-9]\d*"\}/gu;

/** Codex Desktop control syntax is presentation metadata, never assistant prose. */
export function visibleCodexAssistantText(value: string): string {
  return value.replace(codexResponseAnnotationDirective, "").trimStart();
}

/**
 * Streaming chunks are not complete messages: their leading whitespace can be
 * the boundary between two words. Strip presentation directives without
 * trimming that boundary; the completed-item path still normalizes its one
 * whole body through visibleCodexAssistantText.
 */
export function visibleCodexAssistantDelta(value: string): string {
  return value.replace(codexResponseAnnotationDirective, "");
}

function stripSyntheticFileHeader(text: string): string {
  text = stripProviderPromptGuidance(text);
  const trimmedStart = text.trimStart();
  if (!/^# Files (?:mentioned|pasted) by the user:\s*\r?\n/.test(trimmedStart)) return text;
  const requestMarker = /^## My request:\s*\r?\n/m.exec(trimmedStart);
  if (requestMarker === null) return text;
  return trimmedStart.slice(requestMarker.index + requestMarker[0].length).trim();
}

function stripSyntheticRequestMarker(text: string): string {
  const trimmedStart = text.trimStart();
  const requestMarker = /^## My request:\s*\r?\n/.exec(trimmedStart);
  return requestMarker === null ? text : trimmedStart.slice(requestMarker[0].length).trim();
}

function pastedFileMimeType(name: string): string | undefined {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return undefined;
}

/** Convert Codex Desktop's pasted-text transport envelope into a safe widget part. */
function syntheticPastedFileParts(text: string): readonly ContentPart[] {
  const trimmedStart = stripPrivateBootstrapPrefixes(stripProviderPromptGuidance(text)).text.trimStart();
  if (!/^# Files pasted by the user:\s*\r?\n/.test(trimmedStart)) return [];
  const requestMarker = /^## My request:\s*\r?\n/m.exec(trimmedStart);
  if (requestMarker === null) return [];
  const header = trimmedStart.slice(0, requestMarker.index);
  const files: ContentPart[] = [];
  for (const line of header.split(/\r?\n/u)) {
    if (!line.startsWith("## ")) continue;
    const separator = line.lastIndexOf(": ");
    if (separator < 3) continue;
    const name = safeFilename(line.slice(separator + 2));
    if (name === undefined) continue;
    const displayName = /^pasted-text(?:-\d+)?\.txt$/iu.test(name) ? "Pasted text" : name;
    const mimeType = pastedFileMimeType(name);
    files.push({ type: "file", name: displayName, ...(mimeType !== undefined ? { mimeType } : {}) });
  }
  return files;
}

const privateBootstrapPrefixes = [
  /^\s*<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/iu,
  /^\s*<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*/iu,
  /^\s*# AGENTS\.md instructions(?: for [^\r\n]+)?\s*\r?\n+[\s\S]*?<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/iu,
  /^\s*# AGENTS\.md instructions(?: for [^\r\n]+)?\s*\r?\n+[\s\S]*?(?=<environment_context>)/iu,
  /^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu,
  /^\s*<permissions instructions>[\s\S]*?<\/permissions instructions>\s*/iu,
  /^\s*<apps_instructions>[\s\S]*?<\/apps_instructions>\s*/iu,
  /^\s*<skills_instructions>[\s\S]*?<\/skills_instructions>\s*/iu,
  /^\s*<app-context>[\s\S]*?<\/app-context>\s*/iu,
  /^\s*<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>\s*/iu,
];

function stripPrivateBootstrapPrefixes(value: string): { text: string; stripped: boolean } {
  let text = value;
  let strippedAny = false;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const pattern of privateBootstrapPrefixes) {
      const next = text.replace(pattern, "");
      if (next === text) continue;
      text = next;
      stripped = true;
      strippedAny = true;
      break;
    }
  }
  return { text, stripped: strippedAny };
}

const codexDelegationEnvelope = /^\s*<codex_delegation>\s*<source_thread_id>[^<]*<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>\s*$/iu;

interface NormalizedCodexUserText {
  readonly text: string;
  readonly origin?: RemoteMessageOrigin;
  readonly realtimeVoice?: boolean;
}

/** True only for Codex Desktop's private voice-to-backend handoff envelope. */
export function isCodexRealtimeDelegationText(value: string): boolean {
  return /^\s*<realtime_delegation(?:\s|>)/iu.test(value);
}

function normalizedRealtimeDelegation(value: string): NormalizedCodexUserText | null {
  if (!isCodexRealtimeDelegationText(value)) return null;
  // The final call handoff is runtime bookkeeping, not something the user said.
  if (/<source>\s*transcript_tail_flush\s*<\/source>/iu.test(value)) return { text: "", realtimeVoice: true };
  const input = /<input>([\s\S]*?)(?:<\/input>|(?=<transcript_delta>)|(?=<\/realtime_delegation>)|$)/iu.exec(value);
  return { text: (input?.[1] ?? "").trim(), realtimeVoice: true };
}

function normalizedCodexUserText(value: string): NormalizedCodexUserText {
  let text = stripSyntheticFileHeader(value);
  const privateEnvelope = stripPrivateBootstrapPrefixes(text);
  text = stripSyntheticFileHeader(privateEnvelope.text);
  if (privateEnvelope.stripped) text = stripSyntheticRequestMarker(text);
  if (/^\s*<turn_aborted(?:\s*\/?>|>)[\s\S]*?(?:<\/turn_aborted>\s*)?$/iu.test(text)) return { text: "" };
  const realtime = normalizedRealtimeDelegation(text);
  if (realtime !== null) return realtime;
  const delegation = codexDelegationEnvelope.exec(text);
  if (delegation !== null) return { text: (delegation[1] ?? "").trim(), origin: { kind: "delegation", sender: "codex" } };
  return { text };
}

export function normalizeCodexThreadName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizedCodexUserText(value).text.trim() || undefined;
}

/** Codex Desktop records its launch/bootstrap envelope as user content before the real turn. */
export function isCodexBootstrapUserText(value: string): boolean {
  return normalizedCodexUserText(value).text.trim().length === 0 && value.trim().length > 0;
}

export function codexUserContentParts(value: unknown): readonly ContentPart[] {
  const values = Array.isArray(value) ? value : [value];
  const parts: ContentPart[] = [];
  let pendingFilename: string | undefined;
  for (const value of values) {
    if (typeof value === "string") {
      const workflows = providerPromptWorkflows(value);
      parts.push(...syntheticPastedFileParts(value));
      const text = normalizedCodexUserText(value).text;
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
      parts.push(...syntheticPastedFileParts(value.text));
      const text = normalizedCodexUserText(value.text).text;
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
    if (type === "local_image" || type === "localImage") {
      // App Server's canonical UserMessage names the local source path but does
      // not include preview bytes. Preserve only the safe basename so a
      // reopened transcript still shows an honest image widget without sending
      // a private filesystem path to the renderer or a remote client.
      const name = safeFilename(value.filename ?? value.fileName ?? value.name ?? value.path) ?? pendingFilename;
      parts.push({ type: "image", ...(name !== undefined ? { name } : {}) });
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

function contentParts(hostId: string, item: Record<string, unknown>): { parts: readonly ContentPart[]; origin?: RemoteMessageOrigin } {
  const type = typeof item.type === "string" ? item.type : "unknown";
  if (type === "userMessage") {
    const parts = codexUserContentParts(item.content ?? item.text);
    const text = parts.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
    const origin = (Array.isArray(item.content) ? item.content : [item.content ?? item.text])
      .flatMap((entry) => isRecord(entry) && typeof entry.text === "string" ? [normalizedCodexUserText(entry.text).origin] : typeof entry === "string" ? [normalizedCodexUserText(entry).origin] : [])
      .find((candidate): candidate is RemoteMessageOrigin => candidate !== undefined);
    return { parts: isCodexBootstrapUserText(text) ? [] : parts, ...(origin ? { origin } : {}) };
  }
  if (type === "agentMessage" || type === "plan") {
    const text = visibleCodexAssistantText(textFromUnknown(item.content ?? item.text));
    return { parts: text ? [{ type: "text", text }] : [] };
  }
  if (type === "reasoning") {
    const text = textFromUnknown(item.summary ?? item.content ?? item.text);
    return { parts: [text ? { type: "reasoning", text, redacted: false } : { type: "reasoning", text: "Reasoning was not exposed by the provider.", redacted: true }] };
  }
  if (type === "commandExecution") {
    const command = textFromUnknown(item.command) || "command";
    return { parts: [{
      type: "command",
      command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(textFromUnknown(item.aggregatedOutput ?? item.output) ? { output: textFromUnknown(item.aggregatedOutput ?? item.output) } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      status: commandStatus(item.status),
    }] };
  }
  if (type === "fileChange") {
    const paths = changePaths(item);
    return { parts: [{
      type: "file_change",
      path: paths[0] ?? "unknown",
      ...(typeof item.patch === "string" ? { patch: item.patch } : {}),
      ...(paths.length > 1 ? { additionalPaths: paths.slice(1) } : {}),
      change: "unknown",
    }] };
  }
  if (type === "collabAgentToolCall") return { parts: [subagentPart(hostId, item)] };
  if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
    const name = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : type === "webSearch" ? "webSearch" : type;
    const output = type === "webSearch"
      ? Array.isArray(item.results) && item.results.length > 0 ? JSON.stringify(item.results).slice(0, 2_000) : ""
      : textFromUnknown(item.result ?? item.contentItems ?? item.output);
    return { parts: [{
      type: "tool",
      name,
      ...(typeof item.id === "string" ? { callId: item.id } : {}),
      ...(isJsonValue(item.arguments) ? { input: item.arguments } : type === "webSearch" && typeof item.query === "string" ? { input: { query: item.query } } : {}),
      ...(output ? { output } : {}),
      status: toolStatus(item.status),
    }] };
  }
  if (type === "contextCompaction") return { parts: [{ type: "text", text: "Session compacted" }] };
  // Codex may add structured item kinds before this client knows how to
  // present them. Do not flatten an unknown object into assistant prose: it
  // can contain an entire browser snapshot, command trace, or provider
  // envelope. Known conversational and activity kinds are handled above.
  return { parts: [] };
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
      const normalized = contentParts(hostId, itemValue);
      const parts = normalized.parts;
      if (parts.length === 0) continue;
      const nativeId = typeof itemValue.id === "string" ? itemValue.id : `item_${sequence}`;
      const type = typeof itemValue.type === "string" ? itemValue.type : "";
      const role = type === "userMessage" ? "user" : type === "commandExecution" || type === "webSearch" || type.includes("Tool") ? "tool" : "assistant";
      const timestampSource = typeof itemValue.createdAt === "number" && Number.isFinite(itemValue.createdAt)
        ? "item"
        : typeof turn.createdAt === "number" && Number.isFinite(turn.createdAt)
          ? "turn"
          : "thread";
      const createdAt = secondsToIso(itemValue.createdAt ?? turn.createdAt ?? thread.createdAt);
      const turnId = typeof turn.id === "string" && turn.id.trim() ? turn.id.trim() : undefined;
      result.push({
        id: `codex/${nativeId}`,
        sessionId,
        providerMessageId: nativeId,
        role,
        createdAt,
        completedAt: createdAt,
        parts,
        status: "completed",
        ...(normalized.origin ? { origin: normalized.origin } : {}),
        ...(type === "userMessage" && isPlainTextUserMessageItem(itemValue, parts)
          ? { editable: true }
          : {}),
        nativeMetadata: {
          ...sanitizedItemMetadata(itemValue, type),
          ...(turnId !== undefined ? { turnId } : {}),
          ...(type === "userMessage" ? { canonicalUserMessage: true } : {}),
          // The App Server normally omits per-item times. Keep the required
          // display timestamp, but tell reconciliation when it is only a
          // turn/thread fallback so it can never be used to reorder history.
          tethoqCodexTimestampSource: timestampSource,
        },
      });
      sequence += 1;
    }
  }
  return result;
}

function sanitizedItemMetadata(item: Record<string, unknown>, type: string): JsonObject {
  const metadata = jsonObject(item);
  if (type === "userMessage" || type === "agentMessage" || type === "plan") {
    delete metadata.content;
    delete metadata.text;
  }
  return metadata;
}

function isPlainTextUserMessageItem(item: Record<string, unknown>, parts: readonly ContentPart[]): boolean {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.length > 0 &&
    content.every((entry) => isRecord(entry) && (entry.type === "text" || entry.type === "input_text")) &&
    parts.length > 0 &&
    parts.every((part) => part.type === "text");
}
