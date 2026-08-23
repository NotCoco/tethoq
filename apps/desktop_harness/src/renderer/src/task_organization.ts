import type { TaskOverride } from "@shared/desktop_api";
import type { ProviderFilterSelection, ProviderId, Session } from "./types";

/**
 * Explicit provider filters are ORed together. Available agents is a separate
 * capability qualifier, so selecting it narrows the explicit provider set.
 */
export function matchesProviderFilters(providerId: ProviderId, selection: ProviderFilterSelection, availableProviderIds: ReadonlySet<ProviderId>): boolean {
  const filters = selection === "all" ? [] : Array.isArray(selection) ? selection : [selection];
  const explicitProviders = filters.filter((filter) => filter !== "available");
  const requiresAvailable = filters.includes("available");
  return (!explicitProviders.length || explicitProviders.includes(providerId))
    && (!requiresAvailable || availableProviderIds.has(providerId));
}

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
 * Archived tasks stay out of every default surface. They remain visible only while
 * the user deliberately enables the archived-task view. The open conversation may
 * remain on screen, but archiving it must remove its row from the ordinary task list.
 */
export function isHiddenByArchive(session: Session, showArchived: boolean): boolean {
  return Boolean(session.archived) && !showArchived;
}
