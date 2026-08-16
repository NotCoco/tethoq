import type { TaskOverride } from "@shared/desktop_api";
import type { Session } from "./types";

/**
 * Applies the user's own task organisation on top of what a provider reports.
 * A local name replaces the generated title for display only; the provider's own
 * title is never rewritten upstream, so reopening the task elsewhere is unaffected.
 */
export function organizeSessions(sessions: readonly Session[], overrides: Readonly<Record<string, TaskOverride>>): Session[] {
  return sessions.map((session) => {
    const override = overrides[session.id];
    if (!override) return session;
    const title = override.title?.trim();
    return {
      ...session,
      ...(title ? { title, renamed: true } : {}),
      ...(override.pinned ? { pinned: true } : {}),
      ...(override.archived ? { archived: true } : {}),
    };
  });
}

/** Pinned work sits above everything else; the rest keeps real recent-activity order. */
export function compareOrganizedSessions(left: Session, right: Session): number {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

/**
 * Archived tasks stay out of every default surface. They remain visible while the
 * user is deliberately looking at them, or while one is the open task, so archiving
 * the task you are reading never yanks it out from under you.
 */
export function isHiddenByArchive(session: Session, showArchived: boolean, selectedSessionId: string | null): boolean {
  return Boolean(session.archived) && !showArchived && session.id !== selectedSessionId;
}
