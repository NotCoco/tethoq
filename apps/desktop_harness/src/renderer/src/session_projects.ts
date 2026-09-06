import type { Session } from "./types";
import { normalizeProjectDirectory, normalizeSavedProjectDirectories } from "../../shared/project_directories";
export { normalizeProjectDirectory } from "../../shared/project_directories";

export interface SessionProjectGroup {
  readonly key: string;
  readonly name: string;
  readonly directory: string;
  readonly sessions: readonly Session[];
  readonly updatedAt: string;
}

function parsedTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function encodedPathSlug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Codex's dated worktree folders can carry the encoded parent path in their
 * basename (for example `c-users-example-documents-sample-project`).
 * Remove only a prefix that can be proved from the real ancestor path. An
 * ordinary folder inside a date-named directory therefore remains untouched.
 */
function generatedProjectTail(directory: string, basename: string): string | undefined {
  const parts = directory.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  const dateIndex = parts.length - 2;
  if (dateIndex < 2 || !/^\d{4}-\d{2}-\d{2}$/u.test(parts[dateIndex] ?? "")) return undefined;

  const slug = encodedPathSlug(basename);
  if (!slug) return undefined;
  let encodedParent = "";
  for (let end = 2; end <= dateIndex; end += 1) {
    const candidate = encodedPathSlug(parts.slice(0, end).join("-"));
    if (candidate && slug.startsWith(`${candidate}-`) && candidate.length > encodedParent.length) encodedParent = candidate;
  }
  if (!encodedParent) return undefined;
  const tail = slug.slice(encodedParent.length + 1);
  return tail || undefined;
}

export function projectDirectoryName(directory: string, fallback = "No project folder"): string {
  const trimmed = typeof directory === "string" ? directory.trim() : "";
  if (!trimmed) return fallback;
  if (trimmed === "/") return "/";
  if (/^[a-z]:[\\/]?$/iu.test(trimmed)) return `${trimmed[0]?.toUpperCase() ?? ""}:\\`;
  const parts = trimmed.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  const basename = parts.at(-1) ?? "";
  return generatedProjectTail(trimmed, basename) ?? (basename || fallback);
}

export function groupSessionsByProject(sessions: readonly Session[], savedDirectories: readonly string[]): readonly SessionProjectGroup[] {
  const grouped = new Map<string, { directory: string; sessions: Session[] }>();
  for (const directory of normalizeSavedProjectDirectories(savedDirectories)) {
    grouped.set(`directory:${normalizeProjectDirectory(directory)}`, { directory, sessions: [] });
  }
  for (const session of sessions) {
    const key = `directory:${normalizeProjectDirectory(session.workingDirectory)}`;
    grouped.get(key)?.sessions.push(session);
  }
  // Folders have a stable place in project view; activity only reorders their tasks.
  return [...grouped.entries()].map(([key, group]) => {
    const updatedAt = group.sessions.reduce((latest, session) => parsedTimestamp(session.updatedAt) > parsedTimestamp(latest) ? session.updatedAt : latest, group.sessions[0]?.updatedAt ?? "1970-01-01T00:00:00.000Z");
    return {
      key,
      name: projectDirectoryName(group.directory),
      directory: group.directory,
      sessions: group.sessions,
      updatedAt,
    };
  });
}

/** Recent use is persisted for next launch; existing folders never jump mid-session. */
export function reconcileProjectDirectoryOrder(previous: readonly string[], saved: readonly string[]): readonly string[] {
  const savedKeys = new Set(saved.map(normalizeProjectDirectory));
  const previousKeys = new Set(previous.map(normalizeProjectDirectory));
  return [...saved.filter((directory) => !previousKeys.has(normalizeProjectDirectory(directory))), ...previous.filter((directory) => savedKeys.has(normalizeProjectDirectory(directory)))];
}

export const initialProjectCount = 3;

export const initialProjectSessionCount = 5;

/**
 * Side-chat identity is persisted twice on purpose: newer catalogues expose the
 * dedicated session kind, while older/sparser provider rows may retain only the
 * durable relationship. Treat either as authoritative so a refresh cannot turn
 * a nested chat into a top-level task or make its stored child row disappear.
 */
export function isSideChatSession(session: Session): boolean {
  return session.sessionKind === "side_chat" || session.relationshipKind === "side_chat";
}

export function sideChatParentSessionId(session: Session): string | undefined {
  if (!isSideChatSession(session)) return undefined;
  return session.parentSessionId ?? session.relationshipSourceSessionId;
}

/**
 * Recency is the top-level task inbox, while project mode is a folder view of
 * every real provider task in that folder. Provider sub-agents therefore
 * belong in project groups, but app-owned side chats and internal helpers do
 * not belong in either list.
 */
export function sessionsForTaskListMode(
  sessions: readonly Session[],
  mode: "recent" | "project",
): readonly Session[] {
  return sessions.filter((session) => {
    if (isSideChatSession(session) || session.sessionKind === "internal") return false;
    return mode === "project" || session.relationshipKind !== "subagent";
  });
}

/**
 * Keep project groups short without making the current task disappear. The
 * selected task replaces the oldest item in the initial window when needed;
 * expanding then restores the complete newest-first list.
 */
export function visibleProjectSessions(
  sessions: readonly Session[],
  selectedId: string | null,
  expanded: boolean,
): readonly Session[] {
  const newestFirst = [...sessions].sort((left, right) => parsedTimestamp(right.updatedAt) - parsedTimestamp(left.updatedAt));
  if (expanded || newestFirst.length <= initialProjectSessionCount) return newestFirst;
  const initial = newestFirst.slice(0, initialProjectSessionCount);
  if (!selectedId || initial.some((session) => session.id === selectedId)) return initial;
  const selected = newestFirst.find((session) => session.id === selectedId);
  return selected ? [...initial.slice(0, initialProjectSessionCount - 1), selected] : initial;
}
