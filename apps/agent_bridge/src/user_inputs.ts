import { randomUUID } from "node:crypto";
import type { JsonObject, UserInputRequest, UserInputResponse } from "../../../packages/protocol/src/index.js";
import type { AgentProviderAdapter, ProviderUserInputResponse } from "../../../packages/provider_contract/src/index.js";

interface PendingUserInput {
  readonly normalized: UserInputRequest;
  readonly adapter: AgentProviderAdapter;
  readonly providerRequestId: string;
  resolving: boolean;
}

function text(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isExpired(request: UserInputRequest): boolean {
  return request.expiresAt !== undefined && Date.parse(request.expiresAt) < Date.now();
}

export class UserInputRegistry {
  readonly #pending = new Map<string, PendingUserInput>();

  public add(
    hostId: string,
    globalSessionId: string,
    adapter: AgentProviderAdapter,
    providerRequestId: string,
    request: JsonObject,
    expiresAt?: string,
  ): UserInputRequest {
    if (adapter.respondToUserInput === undefined) throw new Error(`${adapter.providerId} emitted user input but cannot accept a response`);
    const existing = [...this.#pending.values()].find((entry) => entry.adapter.providerId === adapter.providerId
      && entry.normalized.sessionId === globalSessionId && entry.providerRequestId === providerRequestId);
    if (existing !== undefined) return existing.normalized;
    const requestId = `input_${randomUUID()}`;
    const normalized: UserInputRequest = {
      requestId,
      hostId,
      providerId: adapter.providerId,
      sessionId: globalSessionId,
      providerRequestId,
      createdAt: new Date().toISOString(),
      title: text(request, "title") ?? text(request, "toolName") ?? "Agent needs input",
      ...((text(request, "prompt") ?? text(request, "question") ?? text(request, "description")) !== undefined
        ? { prompt: text(request, "prompt") ?? text(request, "question") ?? text(request, "description") as string }
        : {}),
      request,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.#pending.set(requestId, { normalized, adapter, providerRequestId, resolving: false });
    return normalized;
  }

  public list(onExpired?: (request: UserInputRequest) => void): readonly UserInputRequest[] {
    for (const [requestId, entry] of this.#pending) {
      if (!isExpired(entry.normalized)) continue;
      this.#pending.delete(requestId);
      onExpired?.(entry.normalized);
    }
    return [...this.#pending.values()].filter((entry) => !entry.resolving).map((entry) => entry.normalized);
  }

  public nextExpiryAt(): number | undefined {
    let next: number | undefined;
    for (const entry of this.#pending.values()) {
      if (entry.normalized.expiresAt === undefined) continue;
      const expiresAt = Date.parse(entry.normalized.expiresAt);
      if (!Number.isFinite(expiresAt)) continue;
      if (next === undefined || expiresAt < next) next = expiresAt;
    }
    return next;
  }

  public clearForSession(sessionId: string): readonly UserInputRequest[] {
    const removed: UserInputRequest[] = [];
    for (const [requestId, entry] of this.#pending) {
      if (entry.normalized.sessionId !== sessionId || entry.resolving) continue;
      this.#pending.delete(requestId);
      removed.push(entry.normalized);
    }
    return removed;
  }

  /** Includes an in-flight response so a concurrent snapshot cannot briefly
   * clear a session while its provider is still consuming the answer. */
  public clearProviderRequest(sessionId: string, providerRequestId: string): UserInputRequest | undefined {
    for (const [id, entry] of this.#pending) {
      if (entry.normalized.sessionId !== sessionId || entry.providerRequestId !== providerRequestId) continue;
      this.#pending.delete(id);
      return entry.normalized;
    }
    return undefined;
  }

  /** Includes an in-flight response so a concurrent snapshot cannot briefly
   * clear a session while its provider is still consuming the answer. */
  public hasForSession(sessionId: string): boolean {
    return [...this.#pending.values()].some((entry) =>
      entry.normalized.sessionId === sessionId && !isExpired(entry.normalized));
  }

  public async resolve(hostId: string, response: UserInputResponse): Promise<UserInputRequest> {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined || pending.resolving) throw new Error("User-input request is stale, resolved, or unknown");
    if (pending.normalized.hostId !== hostId) throw new Error("User-input request belongs to a different host");
    if (isExpired(pending.normalized)) {
      this.#pending.delete(response.requestId);
      throw new Error("User-input request has expired");
    }
    if (Object.keys(response.answers).length === 0) throw new Error("At least one answer is required");
    if (pending.adapter.respondToUserInput === undefined) throw new Error("Provider does not support user-input responses");
    pending.resolving = true;
    const providerResponse: ProviderUserInputResponse = { providerRequestId: pending.providerRequestId, answers: response.answers };
    try {
      await pending.adapter.respondToUserInput(providerResponse);
    } catch (error) {
      pending.resolving = false;
      throw error;
    }
    this.#pending.delete(response.requestId);
    return pending.normalized;
  }
}
