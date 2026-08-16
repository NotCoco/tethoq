import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connect, type Socket } from "node:net";

import type {
  EnqueueProviderMessageRequest,
  ProviderQueuedMessage,
  RestoreProviderMessageRequest,
} from "../../provider_contract/src/index.js";

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
const ipcVersions: Readonly<Record<string, number>> = {
  "thread-owner-discovery": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
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
    const state: DesktopQueueState = { ...current };
    if (messages.length === 0) delete state[providerSessionId];
    else state[providerSessionId] = messages;
    const client = await CodexIpcClient.connect(this.#pipePath);
    try {
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        throw new Error("Open this Codex task on the desktop before changing its queue from the phone");
      }
      const response = await client.request(
        "thread-follower-set-queued-follow-ups-state",
        { conversationId: providerSessionId, state },
        owner.handledByClientId,
      );
      if (response.resultType !== "success") throw new Error(response.error ?? "Codex Desktop rejected the queue update");
    } finally {
      client.dispose();
    }
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
  return {
    id: message.id,
    providerSessionId,
    content: message.text,
    state: error === undefined ? "queued" : "failed",
    createdAt: new Date(message.createdAt).toISOString(),
    ...(typeof message.context.tethoqDeveloperInstructions === "string" && message.context.tethoqDeveloperInstructions.trim()
      ? { developerInstructions: message.context.tethoqDeveloperInstructions }
      : {}),
    ...(error !== undefined ? { error } : {}),
  };
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
