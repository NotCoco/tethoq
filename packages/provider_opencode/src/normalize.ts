import { basename } from "node:path";
import {
  makeGlobalSessionId,
  type ContentPart,
  type JsonObject,
  type RemoteMessage,
  type RemoteSession,
  type SessionState,
} from "../../protocol/src/index.js";
import { providerPromptWorkflows, stripProviderPromptGuidance } from "../../provider_contract/src/index.js";

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
  const title = typeof value.title === "string" && value.title.trim() ? stripProviderPromptGuidance(value.title) : "OpenCode session";
  const parentProviderSessionId = typeof value.parentID === "string" && value.parentID.trim() ? value.parentID.trim() : undefined;
  const agentRole = typeof value.agent === "string" && value.agent.trim() ? value.agent.trim() : undefined;
  const modelId = openCodeModelId(value.model);
  const modelMetadata = isRecord(value.model) ? value.model : undefined;
  const rawVariant = typeof modelMetadata?.variant === "string" ? modelMetadata.variant : value.variant;
  const variantId = typeof rawVariant === "string" && rawVariant.trim() ? rawVariant.trim() : undefined;
  const state = normalizeStatus(status);
  const providerStatus = normalizeOpenCodeProviderStatus(status);
  return {
    id: makeGlobalSessionId(hostId, "opencode", value.id),
    hostId,
    providerId: "opencode",
    providerSessionId: value.id,
    title,
    ...(cwd !== undefined ? { workingDirectory: cwd, project: basename(cwd) || cwd } : {}),
    state,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(typeof time.created === "number" ? { createdAt: milliseconds(time.created) } : {}),
    lastActivityAt: milliseconds(time.updated ?? time.created),
    preview: title,
    ...(parentProviderSessionId !== undefined ? { parentSessionId: makeGlobalSessionId(hostId, "opencode", parentProviderSessionId) } : {}),
    // OpenCode sets parentID only for genuine subagent sessions (explore,
    // general, custom agents). Marking them as native subagents keeps them out
    // of the ordinary task list while remaining reachable through the parent.
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

const maxProviderStatusMessageLength = 512;

function safeProviderStatusMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+/giu, " ")
    .replace(/\b(?:request|trace|execution)[\s_-]*id\s*(?:[:=]\s*|\s+)["']?[a-z0-9][a-z0-9._:-]*["']?/giu, " ")
    .replace(/\b(?:req|trace|exec|execution)_[a-z0-9][a-z0-9_-]{5,}\b/giu, " ")
    .replace(/\b(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})\b/giu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  let bounded = sanitized.slice(0, maxProviderStatusMessageLength);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded.trimEnd();
}

export function normalizeOpenCodeProviderStatus(value: unknown): RemoteSession["providerStatus"] {
  if (!isRecord(value) || value.type !== "retry") return undefined;
  const action = isRecord(value.action) ? value.action : {};
  const message = safeProviderStatusMessage(action.message)
    ?? safeProviderStatusMessage(value.message)
    ?? "OpenCode is waiting to retry.";
  const next = value.next;
  const retryDate = typeof next === "number" && Number.isFinite(next) ? new Date(next) : undefined;
  const retryAt = retryDate !== undefined && Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : undefined;
  return {
    kind: "retry",
    message,
    ...(retryAt !== undefined ? { retryAt } : {}),
  };
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

function safeAudioUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:data:audio\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(value) ? value : undefined;
}

type OpenCodeToolPart = Extract<ContentPart, { readonly type: "tool" }>;

function toolInputText(input: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function singleLineToolText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function openCodeToolStatus(value: unknown): OpenCodeToolPart["status"] {
  return value === "running" ? "running" : value === "completed" ? "completed" : value === "error" ? "failed" : "pending";
}

function emptyToolResult(status: OpenCodeToolPart["status"]): string {
  if (status === "running" || status === "pending") return "Running…";
  if (status === "failed") return "Failed without additional output.";
  return "Completed with no output.";
}

function openCodeToolPresentation(tool: string, input: Record<string, unknown>, output: string | undefined, status: OpenCodeToolPart["status"]): { readonly name: string; readonly body: string } {
  const normalizedTool = tool.toLowerCase().replace(/[_-]+/gu, " ");
  const filePath = toolInputText(input, "filePath", "filepath", "path");
  const command = toolInputText(input, "command", "cmd", "script");
  const workdir = toolInputText(input, "workdir", "cwd");
  const oldText = toolInputText(input, "oldString", "oldText", "before");
  const newText = toolInputText(input, "newString", "newText", "after");
  const content = toolInputText(input, "content", "text");
  const displayPath = filePath === undefined ? undefined : singleLineToolText(filePath);
  const displayCommand = command === undefined ? undefined : singleLineToolText(command);

  if (/\b(?:edit|patch|replace|modify|update)\b/u.test(normalizedTool) && displayPath) {
    const detail = [
      `File: ${filePath}`,
      ...(oldText !== undefined ? [`Replaced:\n${oldText}`] : []),
      ...(newText !== undefined ? [`With:\n${newText}`] : []),
      ...(output && !/^edit applied successfully\.?$/iu.test(output.trim()) ? [`Result:\n${output}`] : []),
    ];
    if (detail.length === 1) detail.push(`Result:\n${output?.trim() || emptyToolResult(status)}`);
    return { name: `Edit ${displayPath}`, body: detail.join("\n\n") };
  }

  if (/\b(?:write|create|save|generate)\b/u.test(normalizedTool) && displayPath) {
    const written = content !== undefined ? content : output && !/^wrote file successfully\.?$/iu.test(output.trim()) ? output : emptyToolResult(status);
    return { name: `Write ${displayPath}`, body: `File: ${filePath}\n\nWritten content:\n${written}` };
  }

  if (displayCommand || /\b(?:bash|shell|run|exec|execute|terminal|powershell|cmd)\b/u.test(normalizedTool)) {
    const result = output?.trim() || emptyToolResult(status);
    return {
      name: `Run ${displayCommand || singleLineToolText(tool)}`,
      body: [
        `Command: ${command ?? tool}`,
        ...(workdir !== undefined ? [`Working directory: ${workdir}`] : []),
        `Result:\n${result}`,
      ].join("\n\n"),
    };
  }

  const readableName = singleLineToolText(tool) || "Tool";
  const inputText = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : undefined;
  const result = output?.trim() || emptyToolResult(status);
  return {
    name: readableName.charAt(0).toUpperCase() + readableName.slice(1),
    body: [...(inputText ? [`Input:\n${inputText}`] : []), `Result:\n${result}`].join("\n\n"),
  };
}

export function normalizeOpenCodeToolPart(value: unknown): OpenCodeToolPart | null {
  if (!isRecord(value) || value.type !== "tool") return null;
  const state = isRecord(value.state) ? value.state : {};
  const input = isRecord(state.input) ? state.input : {};
  const tool = typeof value.tool === "string" && value.tool.trim() ? value.tool.trim() : "tool";
  const status = openCodeToolStatus(state.status);
  const output = typeof state.output === "string" ? state.output : undefined;
  const presentation = openCodeToolPresentation(tool, input, output, status);
  return {
    type: "tool",
    name: presentation.name,
    ...(typeof value.callID === "string" ? { callId: value.callID } : {}),
    ...(Object.keys(input).length > 0 ? { input: asJsonObject(input) } : {}),
    output: presentation.body,
    status,
  };
}

/** Live OpenCode events carry the same useful presentation as reopened history. */
export function normalizeOpenCodeToolEventPayload(value: unknown): JsonObject {
  const toolPart = normalizeOpenCodeToolPart(value);
  if (toolPart === null || !isRecord(value)) return asJsonObject(value);
  return {
    type: "tool",
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.messageID === "string" ? { messageID: value.messageID } : {}),
    ...(typeof value.sessionID === "string" ? { sessionID: value.sessionID } : {}),
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    name: toolPart.name,
    ...(toolPart.callId !== undefined ? { callId: toolPart.callId } : {}),
    ...(toolPart.input !== undefined ? { input: toolPart.input } : {}),
    ...(toolPart.output !== undefined ? { output: toolPart.output } : {}),
    status: toolPart.status,
  };
}

function partFromOpenCode(value: unknown): ContentPart | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const providerPartId = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text, ...(providerPartId !== undefined ? { providerPartId } : {}) };
  }
  if (value.type === "reasoning" && typeof value.text === "string") {
    return { type: "reasoning", text: value.text, redacted: false, ...(providerPartId !== undefined ? { providerPartId } : {}) };
  }
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
    if (mimeType?.toLowerCase().startsWith("audio/") === true) {
      const uri = safeAudioUri(value.url ?? value.uri);
      if (uri !== undefined) return { type: "audio", uri, mimeType, name };
    }
    return { type: "file", name, ...(mimeType !== undefined ? { mimeType } : {}) };
  }
  if (value.type === "patch") {
    const files = Array.isArray(value.files)
      ? value.files.flatMap((entry) => typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [])
      : [];
    if (files.length === 0) return null;
    return { type: "file_change", path: files.join(", "), ...(typeof value.hash === "string" ? { patch: value.hash } : {}), change: "modified" };
  }
  if (value.type === "tool") {
    return normalizeOpenCodeToolPart(value);
  }
  return null;
}

/** Mirrors OpenCode's own prompt-loop exception for providers that report
 * `stop` on a step which still has a tool call to execute. */
export function isContinuingOpenCodeToolPart(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "tool") return false;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  if (metadata.providerExecuted === true) return false;
  const state = isRecord(value.state) ? value.state : {};
  const stateMetadata = isRecord(state.metadata) ? state.metadata : {};
  return !(state.status === "error" && stateMetadata.interrupted === true);
}

export function normalizeOpenCodeMessages(hostId: string, providerSessionId: string, value: unknown): readonly RemoteMessage[] {
  if (!Array.isArray(value)) return [];
  const sessionId = makeGlobalSessionId(hostId, "opencode", providerSessionId);
  const messages: RemoteMessage[] = [];
  const terminalParents = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : entry;
    const partsValue = Array.isArray(entry.parts) ? entry.parts : [];
    const id = typeof info.id === "string" ? info.id : `message_${messages.length}`;
    const role = info.role === "user" ? "user" : info.role === "assistant" ? "assistant" : "tool";
    const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
    // A completed no-tool `stop` is the terminal answer for one OpenCode prompt.
    // OpenCode deliberately continues when a provider reports `stop` alongside
    // a tool call, so those steps must remain visible to the following answer.
    if (role === "assistant" && parentId !== undefined && terminalParents.has(parentId)) continue;
    const parts = partsValue.map(partFromOpenCode).filter((part): part is ContentPart => part !== null).flatMap((part): readonly ContentPart[] => {
      if (role !== "user" || part.type !== "text") return [part];
      const workflows = providerPromptWorkflows(part.text).map((workflow): ContentPart => ({ type: "workflow", workflow }));
      const text = stripProviderPromptGuidance(part.text);
      return [...(text.trim() ? [{ ...part, text }] : []), ...workflows];
    });
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
    if (role === "assistant" && parentId !== undefined && info.finish === "stop" && typeof time.completed === "number"
      && !partsValue.some(isContinuingOpenCodeToolPart)) {
      terminalParents.add(parentId);
    }
  }
  return messages;
}
