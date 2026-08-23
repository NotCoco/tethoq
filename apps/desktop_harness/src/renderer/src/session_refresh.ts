import type { Session, SessionContextState, SessionUsageTotals } from "./types";
import { isAmbiguousSelectionValue } from "./composer_helpers";

function sameProviderStatus(left: Session["providerStatus"], right: Session["providerStatus"]): boolean {
  return left === right || (left?.kind === right?.kind && left?.message === right?.message && left?.retryAt === right?.retryAt);
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]));
}

function sameSession(left: Session, right: Session): boolean {
  return left === right || (
    left.id === right.id
    && left.draft === right.draft
    && left.sessionKind === right.sessionKind
    && left.parentSessionId === right.parentSessionId
    && left.relationshipKind === right.relationshipKind
    && left.agentNickname === right.agentNickname
    && left.agentRole === right.agentRole
    && left.providerId === right.providerId
    && left.title === right.title
    && left.state === right.state
    && left.project === right.project
    && left.workingDirectory === right.workingDirectory
    && left.preview === right.preview
    && left.updatedAt === right.updatedAt
    && left.model === right.model
    && left.effort === right.effort
    && sameProviderStatus(left.providerStatus, right.providerStatus)
    && left.unread === right.unread
    && left.childCount === right.childCount
    && sameStrings(left.childProviderIds, right.childProviderIds)
    && left.contextSummary === right.contextSummary
    && left.renamed === right.renamed
    && left.pinned === right.pinned
    && left.archived === right.archived
  );
}

/**
 * Applies a canonical session listing without letting it overwrite live state
 * that changed after the listing began.
 */
export function mergeRefreshedSessions(
  current: readonly Session[],
  incoming: readonly Session[],
  isStreamQuiet?: (sessionId: string) => boolean,
  preserveExisting?: (sessionId: string) => boolean,
): Session[] {
  const prior = new Map(current.map((session) => [session.id, session]));
  return incoming.map((session) => {
    const existing = prior.get(session.id);
    if (!existing) return session;
    if (preserveExisting?.(session.id) === true) return existing;
    const keepEffort = isAmbiguousSelectionValue(session.effort) && !isAmbiguousSelectionValue(existing.effort);
    const existingTerminal = existing.state === "completed" || existing.state === "failed";
    const incomingLive = session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
    if (existingTerminal && incomingLive) {
      const existingUpdatedAt = Date.parse(existing.updatedAt);
      const incomingUpdatedAt = Date.parse(session.updatedAt);
      // A terminal event can start a catalogue refresh before React commits it.
      // Do not let that older response resurrect a task as working; a genuinely
      // newer turn remains free to replace the terminal state.
      if (!Number.isFinite(incomingUpdatedAt) || !Number.isFinite(existingUpdatedAt) || incomingUpdatedAt <= existingUpdatedAt) return existing;
    }
    const live = existing.state === "working" || existing.state === "needs_approval" || existing.state === "needs_input";
    const incomingQuiet = session.state === "idle" || session.state === "completed";
    if (live && incomingQuiet) {
      // A refresh must not flip a working session idle while its chunks are
      // still arriving - but it must eventually settle one whose stream has
      // actually stopped (a missed end event otherwise shimmers forever).
      if (isStreamQuiet?.(session.id) === true) return sameSession(existing, session) ? existing : session;
      const merged = { ...session, state: existing.state, updatedAt: existing.updatedAt, ...(keepEffort ? { effort: existing.effort } : {}) };
      return sameSession(existing, merged) ? existing : merged;
    }
    const merged = keepEffort ? { ...session, effort: existing.effort } : session;
    return sameSession(existing, merged) ? existing : merged;
  });
}

function sameUsage(left: SessionUsageTotals, right: SessionUsageTotals): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.totalTokens === right.totalTokens
    && left.cost === right.cost
    && left.currency === right.currency;
}

/**
 * A context reading is UI state only when one of its displayed/capability values
 * changed. Providers stamp every poll with a fresh `updatedAt`; treating that
 * heartbeat timestamp as content rerendered the whole workspace every 2.5 seconds.
 */
export function sameSessionContext(left: SessionContextState | null, right: SessionContextState): boolean {
  return left !== null
    && left.sessionId === right.sessionId
    && left.modelId === right.modelId
    && left.usedTokens === right.usedTokens
    && left.contextWindowTokens === right.contextWindowTokens
    && left.usedPercent === right.usedPercent
    && left.compactionThresholdTokens === right.compactionThresholdTokens
    && left.minimumThresholdTokens === right.minimumThresholdTokens
    && left.supportsManualCompaction === right.supportsManualCompaction
    && left.supportsThreshold === right.supportsThreshold
    && left.isCompacting === right.isCompacting
    && left.compactionKind === right.compactionKind
    && sameUsage(left.usage, right.usage);
}
