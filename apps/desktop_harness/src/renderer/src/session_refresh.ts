import type { Session, SessionContextState, SessionSchedule, SessionState, SessionUsageTotals, TimelineItem } from "./types";
import { isAmbiguousSelectionValue } from "./composer_helpers";

function sameProviderStatus(left: Session["providerStatus"], right: Session["providerStatus"]): boolean {
  return left === right || (left?.kind === right?.kind && left?.message === right?.message && left?.retryAt === right?.retryAt);
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]));
}

function sameSchedule(left: Session["schedule"], right: Session["schedule"]): boolean {
  return left === right || (left?.id === right?.id
    && left?.runAt === right?.runAt
    && left?.status === right?.status
    && left?.content === right?.content
    && left?.failure === right?.failure);
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
    && left.externalWriter === right.externalWriter
    && sameProviderStatus(left.providerStatus, right.providerStatus)
    && left.unread === right.unread
    && left.childCount === right.childCount
    && sameStrings(left.childProviderIds, right.childProviderIds)
    && left.contextSummary === right.contextSummary
    && left.renamed === right.renamed
    && left.pinned === right.pinned
    && left.archived === right.archived
    && sameSchedule(left.schedule, right.schedule)
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
      const merged = {
        ...session,
        state: existing.state,
        updatedAt: existing.updatedAt,
        ...(keepEffort ? { effort: existing.effort } : {}),
        // If React is preserving the active turn, preserve who owns it too.
        // Otherwise a stale idle catalogue row can route the next instruction
        // back through Codex Desktop while Tethoq's accepted turn is still live.
        ...(existing.externalWriter === false ? { externalWriter: false } : {}),
      };
      return sameSession(existing, merged) ? existing : merged;
    }
    const refreshed = keepEffort ? { ...session, effort: existing.effort } : session;
    // A successful direct send explicitly writes `externalWriter: false` while
    // making the session live. Canonical Codex listings can retain their older
    // Desktop-owner bit throughout that same turn; keep the local ownership
    // claim until a terminal state is accepted. A genuinely external turn
    // starts from a non-live session and therefore does not take this branch.
    const merged = live && incomingLive && existing.externalWriter === false && refreshed.externalWriter === true
      ? { ...refreshed, externalWriter: false }
      : refreshed;
    return sameSession(existing, merged) ? existing : merged;
  });
}

/**
 * Merge one provider-authoritative session.open result without discarding
 * renderer-owned organisation or a user-renamed title.
 */
export function mergeAuthoritativeOpenedSession(current: Session, opened: Session): Session {
  const candidate: Session = {
    ...current,
    ...opened,
    ...(current.renamed ? { title: current.title, renamed: true } : {}),
  };
  if (opened.providerStatus === undefined) delete candidate.providerStatus;
  if (opened.externalWriter !== true) delete candidate.externalWriter;
  if (opened.previewKind === undefined) delete candidate.previewKind;
  return mergeRefreshedSessions([current], [candidate], () => true, () => false)[0] ?? current;
}

/** A placeholder which was cancelled or replaced can never become canonical again. */
export function withoutRetiredScheduledSessions(
  sessions: readonly Session[],
  retiredSessionIds: ReadonlySet<string>,
): Session[] {
  if (retiredSessionIds.size === 0) return sessions as Session[];
  return sessions.filter((session) => !retiredSessionIds.has(session.id));
}

/** Canonical provider evidence always outranks a late scheduler transport result. */
export function scheduledTaskHasProviderEvidence(
  session: Session | undefined,
  timeline: readonly TimelineItem[],
  scheduledTaskId: string | undefined,
): boolean {
  if (session?.state === "completed"
    || (session?.state === "failed"
      && !(scheduledTaskId !== undefined
        && session.schedule?.id === scheduledTaskId
        && session.schedule.status === "failed"))
    || session?.state === "needs_approval"
    || session?.state === "needs_input") return true;
  return timeline.some((item) => item.kind === "error" && item.state === "failed"
    || item.kind === "assistant" && item.state !== "running" && item.body.trim().length > 0
    || item.kind === "user"
      && scheduledTaskId !== undefined
      && item.scheduledTaskId === scheduledTaskId
      && item.messageId !== undefined);
}

export function scheduledTaskFailureCanRetractPresentation(
  session: Session | undefined,
  timeline: readonly TimelineItem[],
  scheduledTaskId: string | undefined,
): boolean {
  return !scheduledTaskHasProviderEvidence(session, timeline, scheduledTaskId);
}

/** A failed scheduler record stops owning UI as soon as the provider proves it ran. */
export function scheduledTaskScheduleAfterProviderEvidence(
  session: Session | undefined,
  timeline: readonly TimelineItem[],
  schedule: SessionSchedule,
): SessionSchedule | null {
  return schedule.status === "failed"
    && scheduledTaskHasProviderEvidence(session, timeline, schedule.id)
    ? null
    : schedule;
}

/** A bounded live event may update status, but cannot shorten the immutable prompt. */
export function scheduledTaskEventSchedule(
  current: Session["schedule"] | undefined,
  incoming: NonNullable<Session["schedule"]>,
): NonNullable<Session["schedule"]> {
  return current?.id === incoming.id
    ? { ...incoming, content: current.content }
    : incoming;
}

/** A late scheduler acknowledgement must not override a turn the provider accepted or closed. */
export function scheduledTaskPresentationState(
  session: Session | undefined,
  timeline: readonly TimelineItem[],
  status: "dispatching" | "started" | "failed",
  scheduledTaskId?: string,
): SessionState | undefined {
  if (status === "failed") return scheduledTaskHasProviderEvidence(session, timeline, scheduledTaskId) ? undefined : "failed";
  if (status === "dispatching") return "working";
  if (session === undefined || session.state === "working") return "working";
  if (session.state !== "idle") return undefined;
  const terminalTimeline = timeline.some((item) => item.kind === "error" && item.state === "failed"
    || item.kind === "assistant" && item.state !== "running" && item.body.trim().length > 0);
  return terminalTimeline ? undefined : "working";
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
