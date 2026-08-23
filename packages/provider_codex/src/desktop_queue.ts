import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { connect, type Socket } from "node:net";

import type {
  EnqueueProviderMessageRequest,
  ProviderQueuedMessageAttachment,
  ProviderQueuedMessage,
  RestoreProviderMessageRequest,
  SendMessageRequest,
  SendMessageResult,
} from "../../provider_contract/src/index.js";
import { codexTurnInput } from "./codex_input.js";

interface DesktopQueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly context: Record<string, unknown>;
  readonly cwd: string;
  readonly createdAt: number;
  readonly mentionedBrowserFamilies?: readonly string[];
  readonly pausedReason?: string | null;
}

type DesktopQueueState = Record<string, readonly DesktopQueuedMessage[]>;

interface IpcResponse {
  readonly type: "response";
  readonly requestId: string;
  readonly resultType: "success" | "error";
  readonly method?: string;
  readonly handledByClientId?: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface CodexDesktopQueueOptions {
  readonly statePath?: string;
  readonly pipePath?: string;
  readonly onChanged: (messages: readonly ProviderQueuedMessage[]) => void | Promise<void>;
}

const queueKey = "queued-follow-ups";
const maximumQueuedPreviewCharacters = 192 * 1024;
const maximumQueuedPreviewCharactersPerMessage = 640 * 1024;
const ipcVersions: Readonly<Record<string, number>> = {
  "thread-owner-discovery": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-steer-turn": 1,
};

export class CodexDesktopQueue {
  readonly #statePath: string;
  readonly #pipePath: string;
  readonly #onChanged: CodexDesktopQueueOptions["onChanged"];
  #watcher: FSWatcher | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #messages: readonly ProviderQueuedMessage[] = [];

  public constructor(options: CodexDesktopQueueOptions) {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    this.#statePath = options.statePath ?? join(codexHome, ".codex-global-state.json");
    this.#pipePath = options.pipePath ?? "\\\\.\\pipe\\codex-ipc";
    this.#onChanged = options.onChanged;
  }

  public async start(): Promise<void> {
    await this.refresh();
    if (this.#watcher !== null) return;
    try {
      this.#watcher = watch(dirname(this.#statePath), (_event, filename) => {
        if (filename?.toString() !== undefined && filename.toString() !== this.#statePath.split(/[\\/]/).at(-1)) return;
        if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = setTimeout(() => {
          this.#refreshTimer = null;
          void this.refresh();
        }, 50);
      });
    } catch {
      // Codex Desktop may not have created its state directory yet.
    }
  }

  public list(): readonly ProviderQueuedMessage[] {
    return this.#messages;
  }

  public async enqueue(providerSessionId: string, request: EnqueueProviderMessageRequest): Promise<ProviderQueuedMessage> {
    if ((request.attachments?.length ?? 0) > 0) throw new Error("Codex Desktop queue synchronization does not yet support attachments");
    const state = await this.readState();
    const desktopMessage: DesktopQueuedMessage = {
      id: randomUUID(),
      text: request.content,
      context: emptyComposerContext(request.content, request.workingDirectory, request.developerInstructions),
      cwd: request.workingDirectory,
      createdAt: Date.now(),
      mentionedBrowserFamilies: [],
      pausedReason: null,
    };
    await this.replaceConversationQueue(providerSessionId, state, [...(state[providerSessionId] ?? []), desktopMessage]);
    return normalizeQueuedMessage(providerSessionId, desktopMessage);
  }

  /** Starts a real turn inside the Codex Desktop process that owns this task. */
  public async startTurn(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const result = await this.tryStartTurn(providerSessionId, request);
    if (result === null) throw new Error("Open this Codex task on the desktop before sending its attachment");
    return result;
  }

  /** Returns null when no Desktop window currently owns the task. */
  public async tryStartTurn(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult | null> {
    const client = await CodexIpcClient.connect(this.#pipePath);
    try {
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        return null;
      }
      const response = await client.request(
        "thread-follower-start-turn",
        {
          conversationId: providerSessionId,
          turnStart: {
            request: {
              threadId: providerSessionId,
              clientUserMessageId: request.requestId,
              input: codexTurnInput(request),
              ...(request.modelId !== undefined ? { model: request.modelId } : {}),
              ...(request.reasoningEffort !== undefined ? { effort: request.reasoningEffort } : {}),
            },
          },
        },
        owner.handledByClientId,
      );
      if (response.resultType !== "success") throw new Error(response.error ?? "Codex Desktop rejected the attachment");
      const forwarded = isRecord(response.result) && isRecord(response.result.result) ? response.result.result : undefined;
      const turn = forwarded !== undefined && isRecord(forwarded.turn) ? forwarded.turn : undefined;
      const turnId = turn !== undefined && typeof turn.id === "string" ? turn.id : undefined;
      if (turnId === undefined || !turnId.trim()) throw new Error("Codex Desktop did not confirm that the audio turn started");
      return { accepted: true, providerTurnId: turnId, details: [] };
    } finally {
      client.dispose();
    }
  }

  /**
   * Moves one native queued follow-up into the turn owned by Codex Desktop.
   * The full original composer record is supplied as `restoreMessage`, so Codex
   * can put back images/files/context if the active turn ends during the steer.
   */
  public async steerQueuedMessage(providerSessionId: string, messageId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const state = await this.readState();
    const current = [...(state[providerSessionId] ?? [])];
    const index = current.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error("That queued Codex instruction is no longer available");
    const original = current[index]!;
    const next = [...current.slice(0, index), ...current.slice(index + 1)];

    const client = await CodexIpcClient.connect(this.#pipePath);
    try {
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        throw new Error("Open this Codex task on the desktop before steering its queued instruction");
      }
      await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, state, next);
      try {
        const response = await client.request(
          "thread-follower-steer-turn",
          {
            conversationId: providerSessionId,
            input: codexTurnInput({ ...request, content: original.text }),
            restoreMessage: original,
            serviceTier: null,
            attachments: [],
            clientUserMessageId: original.id,
          },
          owner.handledByClientId,
        );
        if (response.resultType !== "success") throw new Error(response.error ?? "Codex Desktop rejected the queued steer");
        const forwarded = isRecord(response.result) && isRecord(response.result.result) ? response.result.result : undefined;
        const turnId = forwarded !== undefined && typeof forwarded.turnId === "string" ? forwarded.turnId : undefined;
        return { accepted: true, ...(turnId !== undefined ? { providerTurnId: turnId } : {}), details: [] };
      } catch (error) {
        await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, state, current);
        throw error;
      }
    } finally {
      client.dispose();
    }
  }

  public async restore(providerSessionId: string, request: RestoreProviderMessageRequest): Promise<ProviderQueuedMessage> {
    if ((request.attachments?.length ?? 0) > 0) throw new Error("Codex Desktop queue synchronization does not yet support attachments");
    if (request.originalMessage.providerSessionId !== providerSessionId) {
      throw new Error("The queued instruction belongs to a different Codex task");
    }
    const createdAt = Date.parse(request.originalMessage.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error("The original queued instruction time is invalid");
    const state = await this.readState();
    const current = [...(state[providerSessionId] ?? [])];
    const existing = current.find((message) => message.id === request.originalMessage.id);
    if (existing !== undefined) {
      if (existing.text !== request.content) throw new Error("The original Codex queue ID is already in use");
      return normalizeQueuedMessage(providerSessionId, existing);
    }
    const desktopMessage: DesktopQueuedMessage = {
      id: request.originalMessage.id,
      text: request.content,
      context: emptyComposerContext(request.content, request.workingDirectory, request.developerInstructions),
      cwd: request.workingDirectory,
      createdAt,
      mentionedBrowserFamilies: [],
      pausedReason: null,
    };
    const requestedIndex = request.beforeMessageId === undefined
      ? -1
      : current.findIndex((message) => message.id === request.beforeMessageId);
    const chronologicalIndex = current.findIndex((message) => message.createdAt > createdAt);
    const insertAt = requestedIndex >= 0
      ? requestedIndex
      : chronologicalIndex >= 0 ? chronologicalIndex : current.length;
    current.splice(insertAt, 0, desktopMessage);
    await this.replaceConversationQueue(providerSessionId, state, current);
    return normalizeQueuedMessage(providerSessionId, desktopMessage);
  }

  public async cancel(providerSessionId: string, messageId: string): Promise<boolean> {
    const state = await this.readState();
    const current = state[providerSessionId] ?? [];
    const next = current.filter((message) => message.id !== messageId);
    if (next.length === current.length) return false;
    await this.replaceConversationQueue(providerSessionId, state, next);
    return true;
  }

  public async update(providerSessionId: string, messageId: string, content: string): Promise<ProviderQueuedMessage | null> {
    const trimmed = content.trim();
    if (trimmed.length === 0 || trimmed.length > 100_000) throw new Error("Queued instructions must contain between 1 and 100000 characters");
    const state = await this.readState();
    const current = state[providerSessionId] ?? [];
    const index = current.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const existing = current[index]!;
    const updated: DesktopQueuedMessage = {
      ...existing,
      text: trimmed,
      context: { ...existing.context, prompt: trimmed },
    };
    const next = [...current];
    next[index] = updated;
    await this.replaceConversationQueue(providerSessionId, state, next);
    return normalizeQueuedMessage(providerSessionId, updated);
  }

  public dispose(): void {
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  private async refresh(): Promise<void> {
    const state = await this.readState().catch(() => ({}));
    const next = normalizeQueueState(state);
    if (JSON.stringify(next) === JSON.stringify(this.#messages)) return;
    this.#messages = next;
    await this.#onChanged(next);
  }

  private async readState(): Promise<DesktopQueueState> {
    const source = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
    if (!isRecord(source)) return {};
    return parseQueueState(source[queueKey]);
  }

  private async replaceConversationQueue(
    providerSessionId: string,
    current: DesktopQueueState,
    messages: readonly DesktopQueuedMessage[],
  ): Promise<void> {
    const client = await CodexIpcClient.connect(this.#pipePath);
    try {
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        throw new Error("Open this Codex task on the desktop before changing its queue from the phone");
      }
      await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, current, messages);
    } finally {
      client.dispose();
    }
  }

  private async replaceConversationQueueWithClient(
    client: CodexIpcClient,
    ownerClientId: string,
    providerSessionId: string,
    current: DesktopQueueState,
    messages: readonly DesktopQueuedMessage[],
  ): Promise<void> {
    const state: DesktopQueueState = { ...current };
    if (messages.length === 0) delete state[providerSessionId];
    else state[providerSessionId] = messages;
    const response = await client.request(
      "thread-follower-set-queued-follow-ups-state",
      { conversationId: providerSessionId, state },
      ownerClientId,
    );
    if (response.resultType !== "success") throw new Error(response.error ?? "Codex Desktop rejected the queue update");
    this.#messages = normalizeQueueState(state);
    await this.#onChanged(this.#messages);
  }
}

class CodexIpcClient {
  readonly #socket: Socket;
  readonly #pending = new Map<string, (response: IpcResponse) => void>();
  #clientId = "initializing-client";
  #buffer = Buffer.alloc(0);

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
  }

  public static async connect(pipePath: string): Promise<CodexIpcClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(pipePath, () => resolve(candidate));
      candidate.once("error", reject);
    });
    const client = new CodexIpcClient(socket);
    const initialized = await client.request("initialize", { clientType: "tethoq" });
    if (initialized.resultType !== "success" || !isRecord(initialized.result) || typeof initialized.result.clientId !== "string") {
      client.dispose();
      throw new Error("Could not join the Codex Desktop coordination channel");
    }
    client.#clientId = initialized.result.clientId;
    return client;
  }

  public async request(method: string, params: Record<string, unknown>, targetClientId?: string): Promise<IpcResponse> {
    const requestId = randomUUID();
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, 5_000);
      this.#pending.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.writeFrame({
      type: "request",
      requestId,
      sourceClientId: this.#clientId,
      version: ipcVersions[method] ?? 0,
      method,
      params,
      ...(targetClientId !== undefined ? { targetClientId } : {}),
    });
    return await response;
  }

  public dispose(): void {
    this.#socket.destroy();
    this.#pending.clear();
  }

  private writeFrame(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.#socket.write(frame);
  }

  private handleData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) {
        this.dispose();
        return;
      }
      if (this.#buffer.length < 4 + length) return;
      const source = JSON.parse(this.#buffer.subarray(4, 4 + length).toString("utf8")) as unknown;
      this.#buffer = this.#buffer.subarray(4 + length);
      if (!isRecord(source) || source.type !== "response" || typeof source.requestId !== "string") continue;
      const resolve = this.#pending.get(source.requestId);
      if (resolve === undefined) continue;
      this.#pending.delete(source.requestId);
      resolve(source as unknown as IpcResponse);
    }
  }
}

function emptyComposerContext(prompt: string, workingDirectory: string, developerInstructions?: string): Record<string, unknown> {
  return {
    addedFiles: [],
    chatGptConversationContexts: [],
    ideContext: null,
    imageAttachments: [],
    imageCommentDrafts: [],
    prompt,
    appshotContexts: [],
    fileAttachments: [],
    pastedTextAttachments: [],
    inAppBrowserContext: null,
    commentAttachments: [],
    mcpAppModelContextAttachments: [],
    selectedTextAttachments: [],
    responseTextAnnotations: [],
    pullRequestChecks: [],
    pullRequestMergeConflict: null,
    existingWorkspaceRoot: null,
    localProjectId: null,
    workspaceRoots: [workingDirectory],
    threadReferences: [],
    ...(developerInstructions !== undefined ? { tethoqDeveloperInstructions: developerInstructions } : {}),
  };
}

function parseQueueState(value: unknown): DesktopQueueState {
  if (!isRecord(value)) return {};
  const result: Record<string, readonly DesktopQueuedMessage[]> = {};
  for (const [providerSessionId, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) continue;
    const valid = messages.filter(isDesktopQueuedMessage);
    if (valid.length > 0) result[providerSessionId] = valid;
  }
  return result;
}

function normalizeQueueState(state: DesktopQueueState): readonly ProviderQueuedMessage[] {
  return Object.entries(state)
    .flatMap(([providerSessionId, messages]) => messages.map((message) => normalizeQueuedMessage(providerSessionId, message)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function normalizeQueuedMessage(providerSessionId: string, message: DesktopQueuedMessage): ProviderQueuedMessage {
  const error = typeof message.pausedReason === "string" && message.pausedReason.trim() ? message.pausedReason : undefined;
  const attachments = nativeQueuedAttachments(message.context);
  return {
    id: message.id,
    providerSessionId,
    content: message.text,
    state: error === undefined ? "queued" : "failed",
    createdAt: new Date(message.createdAt).toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof message.context.tethoqDeveloperInstructions === "string" && message.context.tethoqDeveloperInstructions.trim()
      ? { developerInstructions: message.context.tethoqDeveloperInstructions }
      : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function nativeQueuedAttachments(context: Record<string, unknown>): readonly ProviderQueuedMessageAttachment[] {
  const result: ProviderQueuedMessageAttachment[] = [];
  let previewCharacters = 0;
  const seen = new Set<string>();
  const append = (value: unknown, fallbackName: string, fallbackMimeType: string): void => {
    if (!isRecord(value)) return;
    const previewCandidate = firstString(value.previewSrc, value.imageDataUrl, value.uploadSrc, value.src, value.dataUrl);
    const preview = safeQueuedPreview(previewCandidate, previewCharacters);
    if (preview !== undefined) previewCharacters += preview.length;
    const pathCandidate = firstString(value.localPath, value.path, value.imagePath);
    const name = firstString(value.filename, value.fileName, value.name, value.title)
      ?? (pathCandidate === undefined ? undefined : basename(pathCandidate))
      ?? fallbackName;
    const mimeType = firstMimeType(value.mimeType, value.mediaType, value.contentType)
      ?? mimeTypeFromDataUrl(preview)
      ?? mimeTypeFromName(name)
      ?? fallbackMimeType;
    const byteLength = firstNonNegativeNumber(value.byteLength, value.size, value.fileSize)
      ?? decodedDataUrlBytes(preview)
      ?? 0;
    const durationSeconds = firstPositiveNumber(value.durationSeconds, value.duration);
    const key = `${name}\u0000${mimeType}\u0000${byteLength}\u0000${preview ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      name,
      mimeType,
      byteLength,
      ...(preview !== undefined ? { dataUrl: preview } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    });
  };
  const appendArray = (value: unknown, fallbackName: string, fallbackMimeType: string): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) append(item, fallbackName, fallbackMimeType);
  };

  appendArray(context.imageAttachments, "Image", "image/*");
  appendArray(context.appshotContexts, "App screenshot", "image/*");
  appendArray(context.mcpAppModelContextAttachments, "Image", "image/*");
  appendArray(context.fileAttachments, "File", "application/octet-stream");
  appendArray(context.pastedTextAttachments, "Pasted text", "text/plain");
  return result;
}

function safeQueuedPreview(value: string | undefined, usedCharacters: number): string | undefined {
  if (value === undefined || value.length > maximumQueuedPreviewCharacters) return undefined;
  if (usedCharacters + value.length > maximumQueuedPreviewCharactersPerMessage) return undefined;
  return /^data:(?:image|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/iu.test(value) ? value : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function firstMimeType(...values: readonly unknown[]): string | undefined {
  return firstString(...values)?.match(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu)?.[0]?.toLowerCase();
}

function firstNonNegativeNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  return undefined;
}

function firstPositiveNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function mimeTypeFromDataUrl(value: string | undefined): string | undefined {
  return value?.match(/^data:([^;,]+);base64,/iu)?.[1]?.toLowerCase();
}

function mimeTypeFromName(name: string): string | undefined {
  switch (extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".pdf": return "application/pdf";
    default: return undefined;
  }
}

function decodedDataUrlBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const encoded = value.slice(value.indexOf(",") + 1);
  if (!encoded) return 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0));
}

function isDesktopQueuedMessage(value: unknown): value is DesktopQueuedMessage {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.cwd === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    isRecord(value.context) &&
    (value.mentionedBrowserFamilies === undefined || (Array.isArray(value.mentionedBrowserFamilies) && value.mentionedBrowserFamilies.every((item) => typeof item === "string")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
