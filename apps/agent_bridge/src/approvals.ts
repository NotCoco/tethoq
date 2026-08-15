import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalResponse } from "../../../packages/protocol/src/index.js";
import type { AgentProviderAdapter, ProviderApprovalRequest } from "../../../packages/provider_contract/src/index.js";

interface PendingApproval {
  readonly normalized: ApprovalRequest;
  readonly adapter: AgentProviderAdapter;
  readonly providerRequestId: string;
  resolving: boolean;
}

function isExpired(request: ApprovalRequest): boolean {
  return request.expiresAt !== undefined && Date.parse(request.expiresAt) < Date.now();
}

export class ApprovalRegistry {
  readonly #pending = new Map<string, PendingApproval>();

  public add(hostId: string, globalSessionId: string, adapter: AgentProviderAdapter, input: ProviderApprovalRequest): ApprovalRequest {
    const requestId = `approval_${randomUUID()}`;
    const normalized: ApprovalRequest = {
      requestId,
      hostId,
      providerId: adapter.providerId,
      sessionId: globalSessionId,
      providerRequestId: input.providerRequestId,
      createdAt: new Date().toISOString(),
      title: input.title,
      affectedFiles: input.affectedFiles,
      networkDestinations: input.networkDestinations,
      riskMetadata: input.riskMetadata,
      choices: input.choices,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.#pending.set(requestId, { normalized, adapter, providerRequestId: input.providerRequestId, resolving: false });
    return normalized;
  }

  public list(): readonly ApprovalRequest[] {
    for (const [requestId, entry] of this.#pending) {
      if (isExpired(entry.normalized)) this.#pending.delete(requestId);
    }
    return [...this.#pending.values()].filter((entry) => !entry.resolving).map((entry) => entry.normalized);
  }

  public async resolve(hostId: string, response: ApprovalResponse): Promise<ApprovalRequest> {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined || pending.resolving) throw new Error("Approval request is stale, resolved, or unknown");
    if (pending.normalized.hostId !== hostId) throw new Error("Approval request belongs to a different host");
    if (isExpired(pending.normalized)) {
      this.#pending.delete(response.requestId);
      throw new Error("Approval request has expired");
    }
    const choice = pending.normalized.choices.find((candidate) => candidate.id === response.choiceId);
    if (choice === undefined) throw new Error("Approval choice was not offered by the provider");
    if (pending.adapter.respondToApproval === undefined) throw new Error("Provider does not support approval responses");
    pending.resolving = true;
    try {
      await pending.adapter.respondToApproval({ providerRequestId: pending.providerRequestId, choiceId: response.choiceId });
    } catch (error) {
      pending.resolving = false;
      throw error;
    }
    this.#pending.delete(response.requestId);
    return pending.normalized;
  }
}
