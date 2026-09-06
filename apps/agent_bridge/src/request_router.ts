import { randomUUID } from "node:crypto";
import {
  CURRENT_PROTOCOL_VERSION,
  normalizeSimplifySettings,
  parseSimplifyCommand,
  simplifyDeveloperInstructions,
  sessionGoalStatuses,
  sessionGoalObjectiveMaxLength,
  validateApprovalResponse,
  validateSessionTransferRequest,
  validateUserInputResponse,
  type AgentEvent,
  type ConfigureWalletRequest,
  type EventReplaySlice,
  type JsonObject,
  type DelegationPresentationSegment,
  type DelegationTarget,
  type RemoteMessage,
  type RemoteSession,
  type RequestEnvelope,
  type ResponseEnvelope,
  type WorkflowReference,
  parseGlobalSessionId,
} from "../../../packages/protocol/src/index.js";
import {
  ProviderAdapterError,
  type AuthRequest,
  type CreateSessionOptions,
  type MessageAttachment,
  type SendMessageRequest,
} from "../../../packages/provider_contract/src/index.js";
import { AgentBridge, messageAnchorCursor } from "./bridge.js";
import { RequestLedger } from "../../../packages/protocol/src/index.js";
import { maxScheduledTaskListPayloadBytes, scheduledTaskListPayloadBytes } from "./scheduled_task_store.js";
import { recordStartupProfile } from "./startup_profile.js";
import { maxMessageAttachments } from "./attachment_uploads.js";

export type DesktopProcessState = "running" | "stopped" | "starting";

export interface DesktopLifecycleController {
  status(): Promise<{ readonly state: DesktopProcessState }> | { readonly state: DesktopProcessState };
  wake(): Promise<{ readonly state: Exclude<DesktopProcessState, "stopped">; readonly launched: boolean }>;
}

export class DesktopLifecycleError extends Error {
  public constructor(
    public readonly code: "DESKTOP_NOT_INSTALLED" | "DESKTOP_WAKE_FAILED",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DesktopLifecycleError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function textField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`${field} must be a string`);
  return result;
}

function messageContentField(value: Record<string, unknown>, hasNonTextContent: boolean): string {
  const result = value.content;
  if (typeof result !== "string" || (result.length === 0 && !hasNonTextContent)) {
    throw new Error("content must be a non-empty string");
  }
  return result;
}

function stringArray(value: unknown, field: string, maximum: number): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`${field} must contain at most ${maximum} non-empty strings`);
  }
  return value;
}

function messageAttachmentIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > maxMessageAttachments || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`You can attach up to ${maxMessageAttachments} files to one message`);
  }
  return value;
}

function requireEmptyPayload(value: JsonObject, requestType: string): void {
  if (Object.keys(value).length !== 0) throw new Error(`${requestType} does not accept any payload fields`);
}

function messageMetadata(input: Record<string, unknown>): JsonObject | undefined {
  const metadata: JsonObject = {};
  if (input.simplify !== undefined) metadata.simplify = simplifyMetadata(input.simplify);
  if (input.goal !== undefined) {
    const goal = record(input.goal, "goal");
    const objective = stringField(goal, "objective").trim();
    if (!objective || objective.length > sessionGoalObjectiveMaxLength) throw new Error(`Goal objective must contain between 1 and ${sessionGoalObjectiveMaxLength} characters`);
    metadata.tethoqGoalObjective = objective;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function queuedMessageInput(input: Record<string, unknown>, requestId: string) {
  const attachmentIds = input.attachmentIds === undefined ? undefined : messageAttachmentIds(input.attachmentIds);
  const workflows = input.workflows === undefined ? undefined : workflowReferences(input.workflows);
  const metadata = messageMetadata(input);
  return {
    requestId,
    content: messageContentField(input, (attachmentIds?.length ?? 0) > 0 || (workflows?.length ?? 0) > 0),
    ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
    ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
    ...(workflows !== undefined ? { workflows } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function workflowReferences(value: unknown): readonly WorkflowReference[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw new Error("workflows must contain between one and four recordings");
  return value.map((entry) => {
    const input = record(entry, "workflow");
    const id = stringField(input, "id").trim();
    const name = stringField(input, "name").trim();
    const promptReference = stringField(input, "promptReference").trim();
    const eventCount = input.eventCount;
    const screenshotCount = input.screenshotCount;
    if (!id || id.length > 160 || !name || name.length > 160 || !promptReference || promptReference.length > 8_000) throw new Error("workflow reference is invalid");
    if (!Number.isSafeInteger(eventCount) || (eventCount as number) < 0 || !Number.isSafeInteger(screenshotCount) || (screenshotCount as number) < 0) throw new Error("workflow summary is invalid");
    const applications = input.applications === undefined
      ? []
      : stringArray(input.applications, "applications", 8).map((item) => item.trim()).filter(Boolean);
    return {
      id,
      name,
      eventCount: eventCount as number,
      screenshotCount: screenshotCount as number,
      ...(applications.length ? { applications } : {}),
      promptReference,
    };
  });
}

function simplifyMetadata(value: unknown): JsonObject {
  const settings = normalizeSimplifySettings(value);
  const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const target = source.target === "previous" || source.target === "upcoming" ? source.target : undefined;
  return {
    maxWords: settings.maxWords,
    ...(settings.guidance !== undefined ? { guidance: settings.guidance } : {}),
    ...(target !== undefined ? { target } : {}),
  };
}

function simplifiedFirstInstruction(content: string, settingsValue: unknown): {
  readonly content: string;
  readonly developerInstructions?: string;
} {
  const parsed = parseSimplifyCommand(content);
  const explicit = typeof settingsValue === "object" && settingsValue !== null && !Array.isArray(settingsValue)
    && ((settingsValue as Record<string, unknown>).target === "previous" || (settingsValue as Record<string, unknown>).target === "upcoming")
      ? (settingsValue as Record<string, unknown>).target as "previous" | "upcoming"
      : undefined;
  if (!parsed.active && explicit === undefined) return { content };
  const settings = normalizeSimplifySettings(settingsValue);
  return {
    content: parsed.active ? parsed.content : content,
    developerInstructions: simplifyDeveloperInstructions(settings, explicit ?? parsed.target),
  };
}

function delegationTargets(value: unknown): readonly DelegationTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new Error("targets must contain between one and four harness selections");
  }
  return value.map((entry) => {
    const target = record(entry, "delegation target");
    return {
      providerId: stringField(target, "providerId"),
      ...(typeof target.modelId === "string" && target.modelId.trim() ? { modelId: target.modelId.trim() } : {}),
      ...(typeof target.reasoningEffort === "string" && target.reasoningEffort.trim()
        ? { reasoningEffort: target.reasoningEffort.trim() }
        : {}),
    };
  });
}

function delegationPresentationSegments(value: unknown): readonly DelegationPresentationSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("presentationSegments must contain between one and 32 ordered segments");
  }
  return value.map((entry): DelegationPresentationSegment => {
    const segment = record(entry, "delegation presentation segment");
    if (segment.type === "text" && typeof segment.text === "string") {
      return { type: "text", text: segment.text };
    }
    if (segment.type === "mesh" && Number.isSafeInteger(segment.targetIndex) && (segment.targetIndex as number) >= 0) {
      return { type: "mesh", targetIndex: segment.targetIndex as number };
    }
    throw new Error("delegation presentation segment is invalid");
  });
}

function legacyDelegationPresentation(
  prompt: string,
  targetCount: number,
): readonly DelegationPresentationSegment[] {
  return [
    ...Array.from({ length: targetCount }, (_, targetIndex) => ({ type: "mesh" as const, targetIndex })),
    ...(prompt.length > 0 ? [{ type: "text" as const, text: prompt }] : []),
  ];
}

function scheduledCommandTokenMatch(value: string, command: string): RegExpExecArray | null {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=$|\\s)`, "iu").exec(value);
}

function removeScheduledCommandToken(value: string, command: string): string {
  let result = value;
  for (;;) {
    const match = scheduledCommandTokenMatch(result, command);
    if (!match) return result;
    const tokenStart = match.index + (match[1]?.length ?? 0);
    const tokenEnd = tokenStart + command.length;
    let before = result.slice(0, tokenStart);
    let after = result.slice(tokenEnd);
    if (!before.trim()) after = after.replace(/^\s/u, "");
    else if (!after.trim()) before = before.replace(/\s$/u, "");
    else if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.replace(/^\s/u, "");
    result = `${before}${after}`;
  }
}

function scheduledTaskContent(value: string, targets: readonly DelegationTarget[] | undefined): string {
  const withoutSchedule = removeScheduledCommandToken(value, "/schedule");
  const containsMesh = scheduledCommandTokenMatch(withoutSchedule, "/mesh") !== null;
  if (containsMesh && targets === undefined) throw new Error("Choose at least one Mesh target before scheduling this task");
  return targets === undefined ? withoutSchedule : removeScheduledCommandToken(withoutSchedule, "/mesh");
}

function visionProxySelection(value: unknown) {
  const selection = record(value, "visual-support selection");
  return {
    providerId: stringField(selection, "providerId"),
    modelId: stringField(selection, "modelId"),
    ...(typeof selection.reasoningEffort === "string" && selection.reasoningEffort.trim()
      ? { reasoningEffort: selection.reasoningEffort.trim() }
      : {}),
  };
}

const maxInlineAttachmentBytes = 1024 * 1024;

function messageAttachments(value: unknown): readonly MessageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) throw new Error("attachments must contain at most one image");
  return value.map((entry) => {
    const attachment = record(entry, "attachment");
    const name = stringField(attachment, "name");
    const mimeType = stringField(attachment, "mimeType");
    const dataBase64 = stringField(attachment, "dataBase64");
    const byteLength = attachment.byteLength;
    if (name.length > 255 || name.includes("/") || name.includes("\\")) throw new Error("attachment name is invalid");
    if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error("only image attachments are supported");
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) <= 0 || (byteLength as number) > maxInlineAttachmentBytes) {
      throw new Error("attachment exceeds the 1 MiB inline limit");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new Error("attachment data is not valid base64");
    const decoded = Buffer.from(dataBase64, "base64");
    if (decoded.byteLength !== byteLength) throw new Error("attachment byte length does not match its data");
    return { name, mimeType, dataBase64, byteLength: byteLength as number };
  });
}

function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function clientSession(session: RemoteSession): Omit<RemoteSession, "nativeMetadata"> & { readonly nativeMetadata: JsonObject } {
  return { ...session, nativeMetadata: {} };
}

const clientMessageBudgetBytes = 384 * 1024;
const clientHistoryBudgetBytes = 1400 * 1024;
const maxSyncEventBatchBytes = 1024 * 1024;
const maxSyncEventsPerBatch = 200;
const imageChunkBytes = 480 * 1024;
const maximumRetrievableImageBytes = 25 * 1024 * 1024;
const maximumImageCacheBytes = 64 * 1024 * 1024;
const imageCacheTtlMs = 5 * 60_000;

interface CachedClientImage {
  readonly id: string;
  readonly sessionId: string;
  readonly sourceKey: string;
  readonly mimeType: string;
  readonly name?: string;
  readonly bytes: Buffer;
  expiresAt: number;
}

class ClientImageCache {
  readonly #entries = new Map<string, CachedClientImage>();
  #bytes = 0;

  public remember(sessionId: string, messageId: string, partIndex: number, uri: string, mimeType?: string, name?: string): string | undefined {
    const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,\s]+(?:=[^;,\s]*)?)*;base64,([a-z0-9+/_-]*={0,2})$/iu.exec(uri);
    if (match === null) return undefined;
    const declaredMimeType = match[1];
    const dataBase64 = match[2];
    if (declaredMimeType === undefined || dataBase64 === undefined) return undefined;
    if (dataBase64.length > Math.ceil(maximumRetrievableImageBytes / 3) * 4 + 4) return undefined;
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.byteLength <= 0 || bytes.byteLength > maximumRetrievableImageBytes) return undefined;
    const sourceKey = `${sessionId}\u0000${messageId}\u0000${partIndex}`;
    this.prune();
    const existing = [...this.#entries.values()].find((entry) => entry.sourceKey === sourceKey);
    if (existing !== undefined && existing.bytes.equals(bytes)) {
      existing.expiresAt = Date.now() + imageCacheTtlMs;
      this.#entries.delete(existing.id);
      this.#entries.set(existing.id, existing);
      return existing.id;
    }
    if (existing !== undefined) this.remove(existing.id);
    const id = `image_${randomUUID()}`;
    const entry: CachedClientImage = {
      id,
      sessionId,
      sourceKey,
      mimeType: mimeType?.startsWith("image/") === true ? mimeType : declaredMimeType,
      ...(name !== undefined ? { name } : {}),
      bytes,
      expiresAt: Date.now() + imageCacheTtlMs,
    };
    this.#entries.set(id, entry);
    this.#bytes += bytes.byteLength;
    this.prune();
    return this.#entries.has(id) ? id : undefined;
  }

  public chunk(sessionId: string, retrievalId: string, offset: number): JsonObject {
    this.prune();
    const entry = this.#entries.get(retrievalId);
    if (entry === undefined || entry.sessionId !== sessionId) throw new Error("The image preview expired; reopen the task to load it again");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.bytes.byteLength || offset % imageChunkBytes !== 0) throw new Error("Image chunk offset is invalid");
    entry.expiresAt = Date.now() + imageCacheTtlMs;
    this.#entries.delete(entry.id);
    this.#entries.set(entry.id, entry);
    const end = Math.min(entry.bytes.byteLength, offset + imageChunkBytes);
    return {
      retrievalId,
      offset,
      totalBytes: entry.bytes.byteLength,
      dataBase64: entry.bytes.subarray(offset, end).toString("base64"),
      nextOffset: end < entry.bytes.byteLength ? end : null,
      mimeType: entry.mimeType,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) this.remove(id);
    while (this.#bytes > maximumImageCacheBytes || this.#entries.size > 128) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#bytes -= entry.bytes.byteLength;
  }
}

function clipText(value: string | undefined, maximum = 24_000): string | undefined {
  if (value === undefined || value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n… output shortened on this device`;
}

/** Keep only presentation semantics; provider diagnostics remain private. */
function clientMessageMetadata(message: RemoteMessage): JsonObject {
  const phase = message.nativeMetadata.phase;
  return phase === "commentary" || phase === "final_answer" ? { phase } : {};
}

function compactMessage(
  message: RemoteMessage,
  rememberImage?: (message: RemoteMessage, partIndex: number, uri: string, mimeType?: string, name?: string) => string | undefined,
): Omit<RemoteMessage, "nativeMetadata"> & { readonly nativeMetadata: JsonObject } {
  const nativeMetadata = clientMessageMetadata(message);
  const clean = { ...message, nativeMetadata };
  // Register inline images lazily even when the rest of the message fits the
  // normal budget. Serializing a base64 image into every page needlessly copies
  // megabytes through the renderer transport and leaves the same payload live
  // in more than one process. The retrieval callback keeps the widget usable.
  const hasInlineImage = rememberImage !== undefined && message.parts.some((part) =>
    part.type === "image" && part.uri?.startsWith("data:") === true);
  if (!hasInlineImage && Buffer.byteLength(JSON.stringify(clean), "utf8") <= clientMessageBudgetBytes) return clean;
  const parts = message.parts.slice(0, 16).map((part, partIndex) => {
    if (part.type === "text" || part.type === "reasoning") return { ...part, text: clipText(part.text) ?? "" };
    if (part.type === "tool") {
      const output = clipText(part.output);
      return { type: part.type, name: part.name, status: part.status, ...(part.callId !== undefined ? { callId: part.callId } : {}), ...(output !== undefined ? { output } : {}) };
    }
    if (part.type === "command") {
      const output = clipText(part.output);
      return { ...part, ...(output !== undefined ? { output } : {}) };
    }
    if (part.type === "file_change") {
      const patch = clipText(part.patch);
      return { type: part.type, path: part.path, change: part.change, ...(patch !== undefined ? { patch } : {}) };
    }
    if (part.type === "image" && part.uri?.startsWith("data:") === true) {
      const retrievalId = rememberImage?.(message, partIndex, part.uri, part.mimeType, part.name);
      return retrievalId === undefined
        ? part
        : { type: part.type, ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}), ...(part.name !== undefined ? { name: part.name } : {}), retrievalId };
    }
    return part;
  });
  return { ...message, parts, nativeMetadata };
}

export function clientMessagePage(
  messages: readonly RemoteMessage[],
  nextCursor: string | null,
  rememberImage?: (message: RemoteMessage, partIndex: number, uri: string, mimeType?: string, name?: string) => string | undefined,
): { readonly messages: readonly RemoteMessage[]; readonly nextCursor: string | null } {
  const compacted = messages.map((message) => compactMessage(message, rememberImage));
  const kept: RemoteMessage[] = [];
  let bytes = 0;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const message = compacted[index]!;
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (kept.length > 0 && bytes + size > clientHistoryBudgetBytes) break;
    kept.unshift(message);
    bytes += size;
  }
  const dropped = compacted.length - kept.length;
  const pageStart = nextCursor === null ? 0 : Number.parseInt(nextCursor, 10);
  return {
    messages: kept,
    nextCursor: dropped > 0
      ? Number.isInteger(pageStart)
        ? String(pageStart + dropped)
        : kept[0] !== undefined ? messageAnchorCursor(kept[0].id) : nextCursor
      : nextCursor,
  };
}

function boundedSyncReplay(replay: EventReplaySlice): JsonObject {
  const events: AgentEvent[] = [];
  let bytes = 0;
  let throughSequence = Math.min(replay.requestedSequence, replay.latestSequence);
  let omittedEventCount = 0;
  let inspectedEventCount = 0;
  for (const event of replay.events) {
    if (inspectedEventCount >= maxSyncEventsPerBatch) break;
    inspectedEventCount += 1;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (events.length > 0 && bytes + eventBytes > maxSyncEventBatchBytes) break;
    if (eventBytes > maxSyncEventBatchBytes) {
      throughSequence = event.sequence;
      omittedEventCount += 1;
      continue;
    }
    events.push(event);
    bytes += eventBytes;
    throughSequence = event.sequence;
  }
  return toJson({
    events,
    requestedSequence: replay.requestedSequence,
    oldestAvailableSequence: replay.oldestAvailableSequence,
    latestSequence: replay.latestSequence,
    throughSequence,
    replayGap: replay.replayGap || omittedEventCount > 0,
    omittedEventCount,
  });
}

const routerLedgers = new WeakMap<AgentBridge, RequestLedger<Promise<ResponseEnvelope>>>();

export class BridgeRequestRouter {
  readonly #ledger: RequestLedger<Promise<ResponseEnvelope>>;
  readonly #images = new ClientImageCache();

  public constructor(
    private readonly bridge: AgentBridge,
    private readonly desktopLifecycle?: DesktopLifecycleController,
  ) {
    const existing = routerLedgers.get(bridge);
    if (existing !== undefined) this.#ledger = existing;
    else {
      this.#ledger = new RequestLedger<Promise<ResponseEnvelope>>();
      routerLedgers.set(bridge, this.#ledger);
    }
  }

  public handle(request: RequestEnvelope): Promise<ResponseEnvelope> {
    const previous = this.#ledger.get(request.requestId);
    if (previous !== undefined) return previous;
    const result = this.execute(request);
    this.#ledger.set(request.requestId, result);
    return result;
  }

  private async execute(request: RequestEnvelope): Promise<ResponseEnvelope> {
    try {
      if (request.hostId !== this.bridge.config.hostId) throw new Error("Request targets a different host");
      const payload = await this.dispatch(request.type, request.payload, request.requestId);
      return this.response(request, true, payload);
    } catch (error) {
      return this.response(request, false, {}, {
        code: error instanceof DesktopLifecycleError
          ? error.code
          : error instanceof ProviderAdapterError
            ? error.code
          : error instanceof Error && error.name === "ProtocolValidationError"
            ? "INVALID_REQUEST"
            : "BRIDGE_REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof DesktopLifecycleError || error instanceof ProviderAdapterError
          ? error.retryable
          : false,
      });
    }
  }

  private async dispatch(type: string, payload: JsonObject, requestId: string): Promise<JsonObject> {
    switch (type) {
      case "host.get":
        return toJson({ host: this.bridge.host() });
      case "desktop.status":
        requireEmptyPayload(payload, type);
        return toJson(this.desktopLifecycle === undefined
          ? { state: "stopped" }
          : await this.desktopLifecycle.status());
      case "desktop.wake":
        requireEmptyPayload(payload, type);
        return toJson(await this.desktopController().wake());
      case "provider.list":
        return toJson({ providers: await this.bridge.providerConnections() });
      case "provider.reconnect": {
        const input = record(payload, "payload");
        await this.bridge.reconnectProvider(stringField(input, "providerId"));
        return {};
      }
      case "provider.authenticate": {
        const input = record(payload, "payload");
        const authRequest: AuthRequest = {
          ...(typeof input.method === "string" ? { method: input.method } : {}),
          ...(typeof input.credential === "string" ? { credential: input.credential } : {}),
          ...(typeof input.metadata === "object" && input.metadata !== null && !Array.isArray(input.metadata) ? { metadata: toJson(input.metadata) } : {}),
        };
        return toJson(await this.bridge.authenticateProvider(stringField(input, "providerId"), authRequest));
      }
      case "models.list": {
        const input = record(payload, "payload");
        return toJson({ models: await this.bridge.listModels(stringField(input, "providerId")) });
      }
      case "wallet.get": {
        const input = record(payload, "payload");
        return toJson({ wallet: await this.bridge.walletStatus(
          stringField(input, "providerId"),
          typeof input.modelId === "string" && input.modelId.length > 0 ? input.modelId : undefined,
          typeof input.endpointId === "string" && input.endpointId.length > 0 ? input.endpointId : undefined,
        ) });
      }
      case "wallet.configure": {
        const input = record(payload, "payload");
        const endpointId = stringField(input, "endpointId");
        if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("apiKey must be a string");
        if (input.validateApiKey !== undefined && typeof input.validateApiKey !== "boolean") throw new Error("validateApiKey must be a boolean");
        if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") throw new Error("clearApiKey must be a boolean");
        if (input.clearBalance !== undefined && typeof input.clearBalance !== "boolean") throw new Error("clearBalance must be a boolean");
        if (input.setBalance !== undefined && (typeof input.setBalance !== "number" || !Number.isFinite(input.setBalance))) throw new Error("setBalance must be a finite number");
        if (input.addBalance !== undefined && (typeof input.addBalance !== "number" || !Number.isFinite(input.addBalance))) throw new Error("addBalance must be a finite number");
        if (input.clearBalance === true && (input.setBalance !== undefined || input.addBalance !== undefined)) throw new Error("clearBalance cannot be combined with a balance update");
        let customEndpoint: ConfigureWalletRequest["customEndpoint"];
        if (input.customEndpoint !== undefined) {
          const custom = record(input.customEndpoint, "customEndpoint");
          const protocol = custom.protocol;
          if (protocol !== "responses" && protocol !== "chat_completions") throw new Error("customEndpoint.protocol is invalid");
          customEndpoint = {
            id: stringField(custom, "id"),
            name: stringField(custom, "name"),
            baseUrl: stringField(custom, "baseUrl"),
            protocol,
            ...(custom.modelIds !== undefined ? { modelIds: stringArray(custom.modelIds, "modelIds", 100) } : {}),
          };
        }
        const configure: ConfigureWalletRequest = {
          endpointId,
          ...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
          ...(typeof input.validateApiKey === "boolean" ? { validateApiKey: input.validateApiKey } : {}),
          ...(typeof input.clearApiKey === "boolean" ? { clearApiKey: input.clearApiKey } : {}),
          ...(typeof input.clearBalance === "boolean" ? { clearBalance: input.clearBalance } : {}),
          ...(typeof input.setBalance === "number" && Number.isFinite(input.setBalance) ? { setBalance: input.setBalance } : {}),
          ...(typeof input.addBalance === "number" && Number.isFinite(input.addBalance) ? { addBalance: input.addBalance } : {}),
          ...(customEndpoint !== undefined ? { customEndpoint } : {}),
        };
        return toJson({ wallet: await this.bridge.configureWallet(stringField(input, "providerId"), configure) });
      }
      case "vision.targets":
        return toJson(await this.bridge.visionProxyTargets());
      case "sessions.refresh": {
        const refreshed = await this.bridge.refresh();
        return toJson({ ...refreshed, sessions: refreshed.sessions.map((session) => clientSession(session)) });
      }
      case "sessions.bootstrap": {
        const bootstrapped = await this.bridge.bootstrapSessions();
        return toJson({ ...bootstrapped, sessions: bootstrapped.sessions.map((session) => clientSession(session)) });
      }
      case "sessions.list":
        return toJson({ sessions: this.bridge.sessions().map((session) => clientSession(session)) });
      case "session.remote_targets": {
        const input = record(payload, "payload");
        const limit = input.limit === undefined ? 20 : input.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit)) throw new Error("limit must be an integer");
        return toJson({ sessions: this.bridge.crossSessionTargets(
          stringField(input, "sessionId"),
          typeof input.query === "string" ? input.query : "",
          limit,
        ).map((session) => clientSession(session)) });
      }
      case "session.remote_inbox.list": {
        const input = record(payload, "payload");
        const limit = input.limit === undefined ? 100 : input.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit)) throw new Error("limit must be an integer");
        return toJson({ messages: this.bridge.crossSessionInbox(stringField(input, "sessionId"), limit) });
      }
      case "session.remote_message.send": {
        const input = record(payload, "payload");
        return toJson({ message: await this.bridge.sendCrossSessionMessage(
          stringField(input, "sourceSessionId"),
          stringField(input, "targetSessionId"),
          requestId,
          stringField(input, "content"),
        ) });
      }
      case "session.watch": {
        const input = record(payload, "payload");
        return { incremental: await this.bridge.watchSession(stringField(input, "sessionId")) };
      }
      case "session.unwatch": {
        const input = record(payload, "payload");
        this.bridge.unwatchSession(stringField(input, "sessionId"));
        return {};
      }
      case "session.open": {
        const startedAt = Date.now();
        const input = record(payload, "payload");
        const sessionId = stringField(input, "sessionId");
        const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
        const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : 40;
        const profile = {
          providerId: parseGlobalSessionId(sessionId).providerId,
          hasCursor: cursor !== undefined,
          refresh: input.refresh === true,
          limit,
        };
        recordStartupProfile({ type: "session-open", phase: "begin", ...profile });
        const opened = await this.bridge.openSession(sessionId, cursor, limit, input.refresh === true);
        recordStartupProfile({
          type: "session-open",
          phase: "bridge.end",
          ...profile,
          durationMs: Date.now() - startedAt,
          messageCount: opened.messages.length,
        });
        const page = clientMessagePage(opened.messages, opened.nextCursor, (message, partIndex, uri, mimeType, name) =>
          this.#images.remember(opened.session.id, message.id, partIndex, uri, mimeType, name));
        recordStartupProfile({
          type: "session-open",
          phase: "client-page.end",
          ...profile,
          durationMs: Date.now() - startedAt,
          messageCount: page.messages.length,
        });
        const response = toJson({
          ...opened,
          session: clientSession(opened.session),
          ...page,
        });
        recordStartupProfile({
          type: "session-open",
          phase: "serialize.end",
          ...profile,
          durationMs: Date.now() - startedAt,
          messageCount: page.messages.length,
        });
        return response;
      }
      case "session.image.get": {
        const input = record(payload, "payload");
        const offset = input.offset === undefined ? 0 : input.offset;
        if (typeof offset !== "number") throw new Error("offset must be a number");
        return this.#images.chunk(stringField(input, "sessionId"), stringField(input, "retrievalId"), offset);
      }
      case "session.children": {
        const input = record(payload, "payload");
        return toJson({ sessions: (await this.bridge.listChildSessions(stringField(input, "sessionId"))).map((session) => clientSession(session)) });
      }
      case "session.side_chats": {
        const input = record(payload, "payload");
        return toJson({ sessions: await this.bridge.listSideChatSessions(stringField(input, "sessionId")) });
      }
      case "session.vision.get": {
        const input = record(payload, "payload");
        return toJson({ vision: await this.bridge.visionProxyStatus(stringField(input, "sessionId")) });
      }
      case "session.vision.configure": {
        const input = record(payload, "payload");
        const selection = input.selection === null ? null : visionProxySelection(input.selection);
        return toJson({ vision: await this.bridge.configureVisionProxy(stringField(input, "sessionId"), selection) });
      }
      case "session.vision.ask": {
        const input = record(payload, "payload");
        const result = await this.bridge.askVisionProxy(
          stringField(input, "sessionId"),
          stringField(input, "question"),
          input.attachments === undefined ? undefined : messageAttachments(input.attachments),
        );
        return toJson({ observation: result.observation });
      }
      case "session.context.get": {
        const input = record(payload, "payload");
        return toJson({ context: await this.bridge.sessionContext(stringField(input, "sessionId")) });
      }
      case "session.goal.get": {
        const input = record(payload, "payload");
        return toJson({ goal: await this.bridge.sessionGoal(stringField(input, "sessionId")) });
      }
      case "session.permissions.get": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.sessionPermissions(stringField(input, "sessionId")));
      }
      case "session.permissions.set": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.setSessionPermission(stringField(input, "sessionId"), stringField(input, "controlId"), stringField(input, "value")));
      }
      case "session.goal.set": {
        const input = record(payload, "payload");
        if (input.objective !== undefined && typeof input.objective !== "string") throw new Error("objective must be a string");
        if (input.status !== undefined && (typeof input.status !== "string" || !sessionGoalStatuses.includes(input.status as never))) {
          throw new Error("status is not a recognized goal state");
        }
        if (input.tokenBudget !== undefined && input.tokenBudget !== null
          && (typeof input.tokenBudget !== "number" || !Number.isSafeInteger(input.tokenBudget))) {
          throw new Error("tokenBudget must be a whole number or null");
        }
        return toJson({ goal: await this.bridge.setSessionGoal(stringField(input, "sessionId"), {
          ...(typeof input.objective === "string" ? { objective: input.objective } : {}),
          ...(typeof input.status === "string" ? { status: input.status as (typeof sessionGoalStatuses)[number] } : {}),
          ...(input.tokenBudget === null || typeof input.tokenBudget === "number" ? { tokenBudget: input.tokenBudget } : {}),
        }) });
      }
      case "session.goal.clear": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.clearSessionGoal(stringField(input, "sessionId")));
      }
      case "session.context.set_threshold": {
        const input = record(payload, "payload");
        const thresholdTokens = input.thresholdTokens;
        if (typeof thresholdTokens !== "number" || !Number.isSafeInteger(thresholdTokens)) {
          throw new Error("thresholdTokens must be a whole number");
        }
        if (input.compactNow !== undefined && typeof input.compactNow !== "boolean") throw new Error("compactNow must be a boolean");
        return toJson({
          context: await this.bridge.setSessionCompactionThreshold(
            stringField(input, "sessionId"),
            thresholdTokens,
            input.compactNow === true,
          ),
        });
      }
      case "session.context.clear_threshold": {
        const input = record(payload, "payload");
        return toJson({ context: await this.bridge.clearSessionCompactionThreshold(stringField(input, "sessionId")) });
      }
      case "session.context.compact": {
        const input = record(payload, "payload");
        const sessionId = stringField(input, "sessionId");
        await this.bridge.compactSession(sessionId);
        return toJson({ context: await this.bridge.sessionContext(sessionId) });
      }
      case "delegation.list": {
        const parentSessionId = typeof payload.parentSessionId === "string" ? payload.parentSessionId : undefined;
        return toJson({ delegations: this.bridge.delegations(parentSessionId) });
      }
      case "delegation.prepare": {
        const input = record(payload, "payload");
        const targets = delegationTargets(input.targets);
        return toJson(await this.bridge.prepareDelegation(
          stringField(input, "parentSessionId"),
          textField(input, "prompt"),
          targets,
          delegationPresentationSegments(input.presentationSegments),
          requestId,
          {
            ...(typeof input.modelId === "string" && input.modelId.trim() ? { modelId: input.modelId.trim() } : {}),
            ...(typeof input.reasoningEffort === "string" && input.reasoningEffort.trim()
              ? { reasoningEffort: input.reasoningEffort.trim() }
              : {}),
          },
        ));
      }
      case "delegation.start": {
        const input = record(payload, "payload");
        const parentSessionId = stringField(input, "parentSessionId");
        const prompt = textField(input, "prompt");
        const targets = delegationTargets(input.targets);
        const prepared = await this.bridge.prepareDelegation(
          parentSessionId,
          prompt,
          targets,
          legacyDelegationPresentation(prompt, targets.length),
          requestId,
        );
        return toJson({ delegation: prepared.delegation });
      }
      case "session.create": {
        const input = record(payload, "payload");
        const first = typeof input.firstInstruction === "string"
          ? simplifiedFirstInstruction(input.firstInstruction, input.simplify)
          : undefined;
        const options: CreateSessionOptions = {
          workingDirectory: typeof input.workingDirectory === "string" ? input.workingDirectory : "",
          ...(typeof input.title === "string" ? { title: input.title } : {}),
          ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
          ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(first !== undefined ? { firstInstruction: first.content } : {}),
          ...(first?.developerInstructions !== undefined ? { firstInstructionDeveloperInstructions: first.developerInstructions } : {}),
        };
        return toJson({ session: clientSession(await this.bridge.createSession(stringField(input, "providerId"), options)) });
      }
      case "scheduled_task.list": {
        const sessionId = payload.sessionId === undefined ? undefined : stringField(payload, "sessionId");
        // Started rows are retained only as a bounded local audit. The renderer
        // needs actionable schedules, and sending completed prompts on every
        // session refresh would turn that audit into repeated large IPC traffic.
        const tasks = this.bridge.scheduledTasks(sessionId).filter((task) => task.status !== "started" && task.status !== "cancelled");
        if (scheduledTaskListPayloadBytes(tasks) > maxScheduledTaskListPayloadBytes) {
          throw new Error("Scheduled-task list exceeds the secure transport limit");
        }
        return toJson({ tasks });
      }
      case "scheduled_task.create": {
        const input = record(payload, "payload");
        const meshTargets = input.meshTargets === undefined ? undefined : delegationTargets(input.meshTargets);
        const task = await this.bridge.createScheduledTask({
          requestId,
          providerId: stringField(input, "providerId"),
          workingDirectory: stringField(input, "workingDirectory"),
          title: stringField(input, "title"),
          content: scheduledTaskContent(stringField(input, "content"), meshTargets),
          runAt: stringField(input, "runAt"),
          ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
          ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(meshTargets !== undefined ? { meshTargets } : {}),
        });
        return toJson({ task });
      }
      case "scheduled_task.cancel": {
        const input = record(payload, "payload");
        return toJson({ task: await this.bridge.cancelScheduledTask(stringField(input, "scheduledTaskId")) });
      }
      case "scheduled_task.run_now": {
        const input = record(payload, "payload");
        return toJson({ task: await this.bridge.runScheduledTaskNow(stringField(input, "scheduledTaskId")) });
      }
      case "scheduled_task.retry": {
        const input = record(payload, "payload");
        if (input.runAt !== undefined && typeof input.runAt !== "string") {
          throw new Error("runAt must be a string");
        }
        return toJson({ task: await this.bridge.retryScheduledTask(
          stringField(input, "scheduledTaskId"),
          typeof input.runAt === "string" ? { runAt: input.runAt } : {},
        ) });
      }
      case "session.context_handoff": {
        const input = validateSessionTransferRequest(payload);
        const result = await this.bridge.contextHandoff(input.sessionId, input.prompt);
        return toJson({ ...result, session: clientSession(result.session) });
      }
      case "session.switch_model": {
        const input = record(payload, "payload");
        const session = await this.bridge.switchSessionModel(stringField(input, "sessionId"), {
          providerId: stringField(input, "providerId"),
          modelId: stringField(input, "modelId"),
          requestId: stringField(input, "requestId"),
          ...(typeof input.reasoningEffort === "string" && input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        });
        return toJson({ session: clientSession(session) });
      }
      case "session.branch": {
        const input = validateSessionTransferRequest(payload);
        const result = await this.bridge.branchSession(input.sessionId, input.prompt);
        return toJson({ ...result, session: clientSession(result.session) });
      }
      case "side_chat.list": {
        const parentSessionId = payload.parentSessionId === undefined ? undefined : stringField(payload, "parentSessionId");
        return toJson({ sessions: this.bridge.sideChats(parentSessionId).map(clientSession) });
      }
      case "side_chat.create": {
        const input = record(payload, "payload");
        const result = await this.bridge.createSideChat(
          stringField(input, "parentSessionId"),
          typeof input.prompt === "string" ? input.prompt : undefined,
          typeof input.queuedMessageId === "string" ? input.queuedMessageId : undefined,
        );
        return toJson({ ...result, session: clientSession(result.session) });
      }
      case "side_chat.promote": {
        const input = record(payload, "payload");
        const result = await this.bridge.promoteSideChat(stringField(input, "sessionId"));
        return toJson({ ...result, session: clientSession(result.session) });
      }
      case "session.continue": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.continueSession(stringField(input, "sessionId"), {
          requestId,
          ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
          ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
        }));
      }
      case "session.send_message": {
        const input = record(payload, "payload");
        const attachmentIds = input.attachmentIds === undefined
          ? undefined
          : messageAttachmentIds(input.attachmentIds);
        if (attachmentIds !== undefined && input.attachments !== undefined) {
          throw new Error("session.send_message accepts attachmentIds or inline attachments, not both");
        }
        const attachments = input.attachments === undefined ? undefined : messageAttachments(input.attachments);
        const workflows = input.workflows === undefined ? undefined : workflowReferences(input.workflows);
        const metadata = messageMetadata(input);
        const message: SendMessageRequest = {
          requestId,
          content: messageContentField(input, (attachmentIds?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0 || (workflows?.length ?? 0) > 0),
          ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
          ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(workflows !== undefined ? { workflows } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        };
        const sessionId = stringField(input, "sessionId");
        return toJson(attachmentIds === undefined
          ? await this.bridge.sendMessage(sessionId, message)
          : await this.bridge.sendUploadedMessage(sessionId, message, attachmentIds));
      }
      case "message_queue.list": {
        const sessionId = payload.sessionId === undefined ? undefined : stringField(payload, "sessionId");
        return toJson({ messages: await this.bridge.refreshQueuedMessages(sessionId) });
      }
      case "message_queue.enqueue": {
        const input = record(payload, "payload");
        return toJson({ message: await this.bridge.enqueueMessage(stringField(input, "sessionId"), queuedMessageInput(input, requestId)) });
      }
      case "message_queue.cancel": {
        const input = record(payload, "payload");
        return { cancelled: await this.bridge.cancelQueuedMessage(stringField(input, "messageId")) };
      }
      case "message_queue.edit": {
        const input = record(payload, "payload");
        return toJson({ message: await this.bridge.editQueuedMessage(
          stringField(input, "messageId"),
          stringField(input, "content"),
        ) });
      }
      case "message_queue.deliver": {
        const input = record(payload, "payload");
        const mode = input.mode;
        if (mode !== "send" && mode !== "steer") throw new Error("mode must be send or steer");
        return { delivered: await this.bridge.deliverQueuedMessage(stringField(input, "messageId"), mode) };
      }
      case "message_queue.move_to_new_task": {
        const input = record(payload, "payload");
        const result = await this.bridge.moveQueuedMessageToNewTask(
          stringField(input, "messageId"),
          {
            providerId: stringField(input, "providerId"),
            modelId: stringField(input, "modelId"),
            ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
          },
        );
        return toJson({ session: clientSession(result.session), delivery: result.delivery });
      }
      case "message_queue.deliver_new_task": {
        const input = record(payload, "payload");
        return toJson({ delivery: await this.bridge.deliverQueuedMessageToNewTask(stringField(input, "deliveryId")) });
      }
      case "session.steer_message": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.steerMessage(stringField(input, "sessionId"), queuedMessageInput(input, requestId)));
      }
      case "session.edit_message": {
        const input = record(payload, "payload");
        return toJson(await this.bridge.editMessage(stringField(input, "sessionId"), {
          requestId,
          providerMessageId: stringField(input, "providerMessageId"),
          content: stringField(input, "content"),
          ...(typeof input.modelId === "string" ? { modelId: input.modelId } : {}),
          ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
        }));
      }
      case "attachment.upload.begin": {
        const input = record(payload, "payload");
        const byteLength = input.byteLength;
        if (!Number.isSafeInteger(byteLength)) throw new Error("byteLength must be an integer");
        return toJson(this.bridge.beginAttachmentUpload({
          name: stringField(input, "name"),
          mimeType: stringField(input, "mimeType"),
          byteLength: byteLength as number,
        }));
      }
      case "attachment.upload.chunk": {
        const input = record(payload, "payload");
        const offset = input.offset;
        if (!Number.isSafeInteger(offset)) throw new Error("offset must be an integer");
        return toJson(this.bridge.appendAttachmentChunk(
          stringField(input, "uploadId"),
          offset as number,
          stringField(input, "dataBase64"),
        ));
      }
      case "attachment.upload.complete": {
        const input = record(payload, "payload");
        return toJson(this.bridge.completeAttachmentUpload(stringField(input, "uploadId")));
      }
      case "attachment.upload.cancel": {
        const input = record(payload, "payload");
        return { discarded: this.bridge.discardAttachmentUpload(stringField(input, "uploadId")) };
      }
      case "ears.process": {
        const input = record(payload, "payload");
        const attachmentIds = stringArray(input.attachmentIds, "attachmentIds", 4);
        return toJson(await this.bridge.processEars({
          providerId: stringField(input, "providerId"),
          modelId: stringField(input, "modelId"),
          mode: stringField(input, "mode"),
          attachmentIds,
          ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
          ...(typeof input.requestId === "string" && input.requestId.trim() ? { requestId: input.requestId.trim() } : {}),
        }));
      }
      case "ears.cancel": {
        const input = record(payload, "payload");
        return toJson(this.bridge.cancelEars(stringField(input, "requestId")));
      }
      case "dictation.transcribe": {
        const input = record(payload, "payload");
        const dictionary = stringArray(input.dictionary, "dictionary", 100);
        if (dictionary.some((entry) => entry.length > 80)) throw new Error("dictionary entries must not exceed 80 characters");
        return toJson(await this.bridge.transcribeDictation(
          stringField(input, "attachmentId"),
          dictionary,
          stringField(input, "sourceId"),
        ));
      }
      case "dictation.source.list":
        return toJson({ sources: this.bridge.transcriptionSources() });
      case "dictation.source.configure": {
        const input = record(payload, "payload");
        const sourceId = stringField(input, "sourceId");
        const clear = input.clear === true;
        if (clear && input.apiKey !== undefined) throw new Error("apiKey and clear cannot be used together");
        const apiKey = clear ? undefined : stringField(input, "apiKey").trim();
        if (apiKey !== undefined && (apiKey.length < 8 || apiKey.length > 512)) {
          throw new Error("apiKey must contain between 8 and 512 characters");
        }
        return toJson({ sources: await this.bridge.configureTranscriptionSource(sourceId, apiKey) });
      }
      case "session.interrupt": {
        const input = record(payload, "payload");
        await this.bridge.interrupt(stringField(input, "sessionId"));
        return {};
      }
      case "approval.list":
        return toJson({ approvals: this.bridge.pendingApprovals() });
      case "approval.respond":
        await this.bridge.respondToApproval(validateApprovalResponse(payload));
        return {};
      case "user_input.list":
        return toJson({ requests: this.bridge.pendingUserInputs() });
      case "user_input.respond":
        await this.bridge.respondToUserInput(validateUserInputResponse(payload));
        return {};
      case "sync.since": {
        const input = record(payload, "payload");
        const sequence = input.sequence;
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
        return boundedSyncReplay(this.bridge.eventReplaySince(sequence));
      }
      case "pairing.start":
        return toJson(this.bridge.startPairing(typeof payload.relayUrl === "string" ? payload.relayUrl : undefined, typeof payload.relayToken === "string" ? payload.relayToken : undefined));
      case "pairing.confirm": {
        const input = record(payload, "payload");
        return toJson(this.bridge.confirmPairing({
          pairingId: stringField(input, "pairingId"),
          secret: stringField(input, "secret"),
          shortCode: stringField(input, "shortCode"),
          deviceId: stringField(input, "deviceId"),
          devicePublicKeyPem: stringField(input, "devicePublicKeyPem"),
        }));
      }
      case "device.list":
        return toJson({ devices: this.bridge.pairedDevices() });
      case "device.revoke":
        return { revoked: this.bridge.revokeDevice(stringField(record(payload, "payload"), "credentialId")) };
      default:
        throw new Error(`Unknown request type ${type}`);
    }
  }

  private desktopController(): DesktopLifecycleController {
    if (this.desktopLifecycle === undefined) {
      throw new DesktopLifecycleError(
        "DESKTOP_NOT_INSTALLED",
        "Tethoq Desktop is not installed with this Bridge.",
        false,
      );
    }
    return this.desktopLifecycle;
  }

  private response(
    request: RequestEnvelope,
    ok: boolean,
    payload: JsonObject,
    error?: ResponseEnvelope["error"],
  ): ResponseEnvelope {
    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      messageId: randomUUID(),
      hostId: this.bridge.config.hostId,
      sentAt: new Date().toISOString(),
      kind: "response",
      type: `${request.type}.result`,
      requestId: request.requestId,
      ok,
      payload,
      ...(error !== undefined ? { error } : {}),
    };
  }
}
