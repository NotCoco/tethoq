import type { JsonObject, RemoteSession } from "../../../packages/protocol/src/index.js";
import type { SessionSelection } from "./session_selection_store.js";

const bridgeNativeMetadataKeys = [
  "tethoqUserStopped",
  "tethoqInterruptedAt",
  "relationshipKind",
  "relationshipSourceSessionId",
  "relationshipStrategy",
  "tethoqHandoffSummary",
  "tethoqHandoffPrompt",
  "tethoqHandoffPending",
  "tethoqModelSwitchSummary",
  "tethoqBranchBootstrap",
  "tethoqBranchPending",
  "tethoqSessionKind",
  "tethoqClientTitle",
  "tethoqClientPreview",
  "tethoqInitialProviderTitle",
  "tethoqObservedExternalLaunch",
  "tethoqObservedExternalLauncherSessionId",
] as const;

export interface SessionCacheOptions {
  /**
   * Reports whether a cached session's "working" state reflects a turn the
   * bridge itself knows is in flight. Provider session listings lag live
   * turns, so a reconcile must not downgrade such sessions while this holds.
   */
  readonly preserveWorking?: (globalSessionId: string) => boolean;
  /** Selections learned in an earlier run, so a restart is not blind. */
  readonly knownSelections?: Readonly<Record<string, SessionSelection>>;
  readonly onSelectionsChange?: (selections: Readonly<Record<string, SessionSelection>>) => void;
  readonly now?: () => Date;
}

/** What the user asked for on the most recent turn of a session. */
export interface RequestedSelection {
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export class SessionCache {
  readonly #sessions = new Map<string, RemoteSession>();
  readonly #knownSelections = new Map<string, SessionSelection>();
  readonly #reportedSelectionGenerations = new Map<string, number>();
  readonly #preserveWorking: (globalSessionId: string) => boolean;
  readonly #onSelectionsChange: ((selections: Readonly<Record<string, SessionSelection>>) => void) | undefined;
  readonly #now: () => Date;
  #selectionBatchDepth = 0;
  #selectionNotificationPending = false;

  public constructor(options: SessionCacheOptions = {}) {
    this.#preserveWorking = options.preserveWorking ?? (() => false);
    this.#onSelectionsChange = options.onSelectionsChange;
    this.#now = options.now ?? (() => new Date());
    for (const [sessionId, selection] of Object.entries(options.knownSelections ?? {})) {
      this.#knownSelections.set(sessionId, selection);
    }
  }

  /**
   * Records what a harness says a session is running. This is the strong signal:
   * it outranks anything Tethoq merely asked for, and is what later fills the gap
   * for harnesses that only reveal the level once a session is opened.
   */
  public rememberReportedSelection(globalSessionId: string, selection: RequestedSelection): void {
    this.recordSelection(globalSessionId, selection, "reported");
  }

  /** Seeds what an earlier run learned, without reporting it back as a change. */
  public restoreSelections(selections: Readonly<Record<string, SessionSelection>>): void {
    for (const [sessionId, selection] of Object.entries(selections)) {
      if (this.#knownSelections.has(sessionId)) continue;
      this.#knownSelections.set(sessionId, selection);
      const session = this.#sessions.get(sessionId);
      if (session !== undefined) this.#sessions.set(sessionId, this.withKnownSelection(session));
    }
  }

  public all(): readonly RemoteSession[] {
    return [...this.#sessions.values()].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  public get(globalSessionId: string): RemoteSession | undefined {
    return this.#sessions.get(globalSessionId);
  }

  public delete(globalSessionId: string): void {
    this.#sessions.delete(globalSessionId);
    this.#knownSelections.delete(globalSessionId);
    this.#reportedSelectionGenerations.delete(globalSessionId);
  }

  public upsert(session: RemoteSession): void {
    // A listing that states the level is the harness reporting it, so learn from it.
    this.learnFromSession(session);
    this.#sessions.set(session.id, withInferredSubagentRelationship(this.withKnownSelection(session)));
  }

  /**
   * Applies a directly fetched provider session only if the cache still contains
   * the exact row that was current when the read began. Provider events replace
   * cached row objects, so this compare-before-apply rule prevents a late idle
   * response from overwriting a newer working event. An uncontested direct read
   * is authoritative and therefore bypasses the catalogue-only working guard.
   */
  public reconcileAuthoritative(session: RemoteSession, expectedCurrent: RemoteSession | undefined): boolean {
    if (this.#sessions.get(session.id) !== expectedCurrent) return false;
    this.reconcileSession(session, false);
    return true;
  }

  /**
   * Records the model and effort a turn was dispatched with, as a stand-in until
   * the harness reports what it is actually running. It deliberately does not
   * outrank the harness: a remembered value that wins forever is how a stale
   * choice survives a change made outside Tethoq.
   */
  public rememberRequestedSelection(globalSessionId: string, selection: RequestedSelection): void {
    this.recordSelection(globalSessionId, selection, "requested");
  }

  /** Changes only when the provider itself reports a model or reasoning level. */
  public reportedSelectionGeneration(globalSessionId: string): number {
    return this.#reportedSelectionGenerations.get(globalSessionId) ?? 0;
  }

  /** Everything learned so far, for persisting across restarts. */
  public knownSelections(): Readonly<Record<string, SessionSelection>> {
    return Object.fromEntries(this.#knownSelections);
  }

  private learnFromSession(session: RemoteSession): void {
    if (session.modelId === undefined && session.reasoningEffort === undefined) return;
    this.recordSelection(session.id, {
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
    }, "reported");
  }

  private recordSelection(
    globalSessionId: string,
    selection: RequestedSelection,
    source: SessionSelection["source"],
  ): void {
    const modelId = selection.modelId?.trim();
    const reasoningEffort = selection.reasoningEffort?.trim();
    if (!modelId && !reasoningEffort) return;
    if (source === "reported") {
      this.#reportedSelectionGenerations.set(
        globalSessionId,
        (this.#reportedSelectionGenerations.get(globalSessionId) ?? 0) + 1,
      );
    }
    const previous = this.#knownSelections.get(globalSessionId);
    // A model change invalidates an effort chosen for the previous model.
    const keepsEffort = !reasoningEffort && (!modelId || modelId === previous?.modelId);
    const carriedEffort = keepsEffort ? previous?.reasoningEffort : undefined;
    const next: SessionSelection = {
      ...(modelId ?? previous?.modelId ? { modelId: modelId ?? previous!.modelId! } : {}),
      ...(reasoningEffort ?? carriedEffort ? { reasoningEffort: reasoningEffort ?? carriedEffort! } : {}),
      source,
      updatedAt: this.#now().toISOString(),
    };
    const changed = next.modelId !== previous?.modelId || next.reasoningEffort !== previous?.reasoningEffort;
    this.#knownSelections.set(globalSessionId, next);
    if (changed) this.notifySelectionsChange();
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    // This is the newest thing known about the session, so it is applied directly.
    const dropsEffort = previous?.reasoningEffort !== undefined && !reasoningEffort && !keepsEffort;
    // Reaffirming the current selection is not a new state observation. Keep
    // the row identity used to reconcile in-flight queue/state operations.
    if (!dropsEffort && (!modelId || modelId === session.modelId)
      && (!reasoningEffort || reasoningEffort === session.reasoningEffort)) return;
    const base = dropsEffort ? withoutEffort(session) : session;
    this.#sessions.set(globalSessionId, {
      ...base,
      ...(modelId ? { modelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  private withKnownSelection(session: RemoteSession): RemoteSession {
    const selection = this.#knownSelections.get(session.id);
    if (selection === undefined) return session;
    // Fill only what the harness has not told us this time. Whatever it reports
    // now is what the session is really running, including a level the user set
    // inside the harness itself, and must not be overwritten by an older value.
    return {
      ...session,
      ...(session.modelId === undefined && selection.modelId !== undefined ? { modelId: selection.modelId } : {}),
      ...(session.reasoningEffort === undefined && selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
  }

  public reconcileProvider(providerId: string, sessions: readonly RemoteSession[]): number {
    return this.batchSelectionNotifications(() => {
      const priorIds = new Set([...this.#sessions.values()]
        .filter((session) => session.providerId === providerId && session.parentSessionId === undefined)
        .map((session) => session.id));
      let newlyDiscovered = 0;
      for (const session of sessions) {
        if (this.reconcileSession(session)) newlyDiscovered += 1;
        priorIds.delete(session.id);
      }
      for (const removedId of priorIds) {
        // A positively-linked child is durable evidence that this task is its
        // mother. Some provider listings briefly omit an externally-owned parent;
        // deleting it here makes the mother row blink out while its children stay
        // cached. Keep only exact relationship sources, never title-like guesses.
        const ownsLinkedSession = [...this.#sessions.values()].some((candidate) =>
          candidate.relationship?.sourceSessionId === removedId);
        if (ownsLinkedSession) continue;
        this.#sessions.delete(removedId);
        this.#knownSelections.delete(removedId);
        this.#reportedSelectionGenerations.delete(removedId);
      }
      return newlyDiscovered;
    });
  }

  /**
   * Applies one provider catalogue page without treating that page as the
   * provider's complete inventory. Startup uses this to make the newest tasks
   * available immediately while older pages are still loading; only
   * reconcileProvider() is allowed to delete sessions after the final page.
   */
  public mergeProviderPage(providerId: string, sessions: readonly RemoteSession[]): number {
    return this.batchSelectionNotifications(() => {
      let newlyDiscovered = 0;
      for (const session of sessions) {
        if (session.providerId !== providerId) continue;
        if (this.reconcileSession(session)) newlyDiscovered += 1;
      }
      return newlyDiscovered;
    });
  }

  public reconcileChildren(parentSessionId: string, sessions: readonly RemoteSession[]): number {
    return this.batchSelectionNotifications(() => {
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
    });
  }

  public markProviderStale(providerId: string): void {
    for (const [id, session] of this.#sessions) {
      if (session.providerId !== providerId) continue;
      this.#sessions.set(id, { ...session, state: "disconnected", stale: true });
    }
  }

  public updateState(
    globalSessionId: string,
    state: RemoteSession["state"],
    needsApproval?: boolean,
    lastActivityAt = new Date().toISOString(),
  ): void {
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    this.#sessions.set(globalSessionId, {
      ...session,
      state,
      lastActivityAt,
      ...(needsApproval !== undefined ? { needsApproval } : {}),
    });
  }

  /**
   * Applies transient provider-owned status detail without manufacturing a
   * transcript message. `null` is an explicit clear; omission is handled by
   * the caller so unrelated events cannot accidentally erase the notice.
   */
  public updateProviderStatus(
    globalSessionId: string,
    providerStatus: NonNullable<RemoteSession["providerStatus"]> | null,
  ): void {
    const session = this.#sessions.get(globalSessionId);
    if (session === undefined) return;
    if (providerStatus === null) {
      const { providerStatus: _cleared, ...rest } = session;
      this.#sessions.set(globalSessionId, rest);
      return;
    }
    this.#sessions.set(globalSessionId, { ...session, providerStatus });
  }

  public updateMetadata(
    globalSessionId: string,
    metadata: Partial<Pick<RemoteSession, "title" | "modelId" | "reasoningEffort" | "variantId" | "parentSessionId" | "relationship" | "sessionKind" | "contextHandoffSummary" | "agentNickname" | "agentRole">>,
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
    this.batchSelectionNotifications(() => {
      this.#sessions.clear();
      for (const session of sessions) this.upsert(session);
    });
  }

  private reconcileSession(session: RemoteSession, preserveWorking = true): boolean {
    this.learnFromSession(session);
    const existing = this.#sessions.get(session.id);
    const state = preserveWorking && this.#preserveWorking(session.id) && existing?.state === "working"
      ? "working"
      : session.state === "unknown" && existing !== undefined && existing.state !== "unknown" && existing.state !== "working"
        ? existing.state
        : session.state;
    const clientTitle = typeof existing?.nativeMetadata.tethoqClientTitle === "string" ? existing.nativeMetadata.tethoqClientTitle : undefined;
    const clientPreview = typeof existing?.nativeMetadata.tethoqClientPreview === "string" ? existing.nativeMetadata.tethoqClientPreview : undefined;
    const initialProviderTitle = typeof existing?.nativeMetadata.tethoqInitialProviderTitle === "string" ? existing.nativeMetadata.tethoqInitialProviderTitle : undefined;
    const keepClientTitle = clientTitle !== undefined && initialProviderTitle !== undefined && session.title === initialProviderTitle;
    // providerStatus deliberately has no existing-session fallback here. A
    // canonical provider refresh that omits it is proof that a transient retry
    // is no longer current, so preserving the cached value would revive a stale
    // notice after reconnect or restart.
    this.#sessions.set(session.id, withInferredSubagentRelationship(this.withKnownSelection({
      ...session,
      ...(keepClientTitle ? { title: clientTitle } : {}),
      ...((session.preview === undefined || session.preview.trim() === "" || session.preview.trim().toLocaleLowerCase() === session.title.trim().toLocaleLowerCase()) && clientPreview !== undefined ? { preview: clientPreview } : {}),
      state,
      stale: false,
      nativeMetadata: { ...session.nativeMetadata, ...bridgeNativeMetadata(existing?.nativeMetadata) },
      ...(session.modelId === undefined && existing?.modelId !== undefined ? { modelId: existing.modelId } : {}),
      ...(session.reasoningEffort === undefined && existing?.reasoningEffort !== undefined ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(session.variantId === undefined && existing?.variantId !== undefined ? { variantId: existing.variantId } : {}),
      ...(session.parentSessionId === undefined && existing?.parentSessionId !== undefined ? { parentSessionId: existing.parentSessionId } : {}),
      ...(session.relationship === undefined && existing?.relationship !== undefined ? { relationship: existing.relationship } : {}),
      ...(session.sessionKind === undefined && existing?.sessionKind !== undefined ? { sessionKind: existing.sessionKind } : {}),
      ...(session.contextHandoffSummary === undefined && existing?.contextHandoffSummary !== undefined ? { contextHandoffSummary: existing.contextHandoffSummary } : {}),
      ...(session.agentNickname === undefined && existing?.agentNickname !== undefined ? { agentNickname: existing.agentNickname } : {}),
      ...(session.agentRole === undefined && existing?.agentRole !== undefined ? { agentRole: existing.agentRole } : {}),
    })));
    return existing === undefined;
  }

  private notifySelectionsChange(): void {
    if (this.#onSelectionsChange === undefined) return;
    if (this.#selectionBatchDepth > 0) {
      this.#selectionNotificationPending = true;
      return;
    }
    this.#onSelectionsChange(this.knownSelections());
  }

  private batchSelectionNotifications<T>(action: () => T): T {
    this.#selectionBatchDepth += 1;
    try {
      return action();
    } finally {
      this.#selectionBatchDepth -= 1;
      if (this.#selectionBatchDepth === 0 && this.#selectionNotificationPending) {
        this.#selectionNotificationPending = false;
        this.#onSelectionsChange?.(this.knownSelections());
      }
    }
  }
}

function withoutEffort(session: RemoteSession): RemoteSession {
  const { reasoningEffort: _dropped, ...rest } = session;
  return rest;
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
  const role = (session.agentRole ?? "").toLowerCase();
  if (!role.includes("delegate") && !role.includes("subagent") && !role.includes("helper")) return session;
  return {
    ...session,
    relationship: {
      kind: "subagent",
      sourceSessionId: session.parentSessionId,
      strategy: "native",
    },
  };
}
