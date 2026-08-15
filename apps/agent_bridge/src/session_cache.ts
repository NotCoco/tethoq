import type { JsonObject, RemoteSession } from "../../../packages/protocol/src/index.js";

const bridgeNativeMetadataKeys = [
  "relationshipKind",
  "relationshipSourceSessionId",
  "relationshipStrategy",
  "tethoqHandoffSummary",
  "tethoqHandoffPrompt",
  "tethoqHandoffPending",
  "tethoqBranchBootstrap",
  "tethoqBranchPending",
] as const;

export class SessionCache {
  readonly #sessions = new Map<string, RemoteSession>();

  public all(): readonly RemoteSession[] {
    return [...this.#sessions.values()].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  public get(globalSessionId: string): RemoteSession | undefined {
    return this.#sessions.get(globalSessionId);
  }

  public upsert(session: RemoteSession): void {
    this.#sessions.set(session.id, withInferredSubagentRelationship(session));
  }

  public reconcileProvider(providerId: string, sessions: readonly RemoteSession[]): number {
    const priorIds = new Set([...this.#sessions.values()]
      .filter((session) => session.providerId === providerId && session.parentSessionId === undefined)
      .map((session) => session.id));
    let newlyDiscovered = 0;
    for (const session of sessions) {
      if (this.reconcileSession(session)) newlyDiscovered += 1;
      priorIds.delete(session.id);
    }
    for (const removedId of priorIds) this.#sessions.delete(removedId);
    return newlyDiscovered;
  }

  public reconcileChildren(parentSessionId: string, sessions: readonly RemoteSession[]): number {
    const priorIds = new Set([...this.#sessions.values()]
      .filter((session) => session.parentSessionId === parentSessionId)
      .map((session) => session.id));
    let newlyDiscovered = 0;
    for (const session of sessions) {
      if (session.parentSessionId !== parentSessionId) continue;
      if (this.reconcileSession(session)) newlyDiscovered += 1;
      priorIds.delete(session.id);
    }
    for (const removedId of priorIds) this.#sessions.delete(removedId);
    return newlyDiscovered;
  }

  public markProviderStale(providerId: string): void {
    for (const [id, session] of this.#sessions) {
      if (session.providerId !== providerId) continue;
      this.#sessions.set(id, { ...session, state: "disconnected", stale: true });
    }
  }

  public updateState(globalSessionId: string, state: RemoteSession["state"], needsApproval?: boolean): void {
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    this.#sessions.set(globalSessionId, {
      ...session,
      state,
      lastActivityAt: new Date().toISOString(),
      ...(needsApproval !== undefined ? { needsApproval } : {}),
    });
  }

  public updateMetadata(
    globalSessionId: string,
    metadata: Partial<Pick<RemoteSession, "modelId" | "reasoningEffort" | "variantId" | "parentSessionId" | "relationship" | "contextHandoffSummary" | "agentNickname" | "agentRole">>,
  ): void {
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    this.#sessions.set(globalSessionId, withInferredSubagentRelationship({ ...session, ...metadata }));
  }

  public updateNativeMetadata(globalSessionId: string, metadata: JsonObject): void {
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    this.#sessions.set(globalSessionId, { ...session, nativeMetadata: { ...session.nativeMetadata, ...metadata } });
  }

  public replace(sessions: readonly RemoteSession[]): void {
    this.#sessions.clear();
    for (const session of sessions) this.upsert(session);
  }

  private reconcileSession(session: RemoteSession): boolean {
    const existing = this.#sessions.get(session.id);
    const state = session.state === "unknown" && existing !== undefined && existing.state !== "unknown"
      ? existing.state
      : session.state;
    this.#sessions.set(session.id, withInferredSubagentRelationship({
      ...session,
      state,
      stale: false,
      nativeMetadata: { ...session.nativeMetadata, ...bridgeNativeMetadata(existing?.nativeMetadata) },
      ...(session.modelId === undefined && existing?.modelId !== undefined ? { modelId: existing.modelId } : {}),
      ...(session.reasoningEffort === undefined && existing?.reasoningEffort !== undefined ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(session.variantId === undefined && existing?.variantId !== undefined ? { variantId: existing.variantId } : {}),
      ...(session.parentSessionId === undefined && existing?.parentSessionId !== undefined ? { parentSessionId: existing.parentSessionId } : {}),
      ...(session.relationship === undefined && existing?.relationship !== undefined ? { relationship: existing.relationship } : {}),
      ...(session.contextHandoffSummary === undefined && existing?.contextHandoffSummary !== undefined ? { contextHandoffSummary: existing.contextHandoffSummary } : {}),
      ...(session.agentNickname === undefined && existing?.agentNickname !== undefined ? { agentNickname: existing.agentNickname } : {}),
      ...(session.agentRole === undefined && existing?.agentRole !== undefined ? { agentRole: existing.agentRole } : {}),
    }));
    return existing === undefined;
  }
}

function bridgeNativeMetadata(metadata: JsonObject | undefined): JsonObject {
  if (metadata === undefined) return {};
  const preserved: JsonObject = {};
  for (const key of bridgeNativeMetadataKeys) {
    const value = metadata[key];
    if (value !== undefined) preserved[key] = value;
  }
  return preserved;
}

function withInferredSubagentRelationship(session: RemoteSession): RemoteSession {
  if (session.relationship !== undefined || session.parentSessionId === undefined) return session;
  return {
    ...session,
    relationship: {
      kind: "subagent",
      sourceSessionId: session.parentSessionId,
      strategy: "native",
    },
  };
}
