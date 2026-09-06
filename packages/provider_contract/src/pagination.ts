import type { AgentProviderAdapter, ListSessionsOptions } from "./types.js";
import type { RemoteSession } from "../../protocol/src/index.js";

export interface CollectedPages {
  readonly sessions: readonly RemoteSession[];
  readonly pages: number;
  readonly authoritative: boolean;
}

export async function collectAllSessionPages(adapter: AgentProviderAdapter, options: Omit<ListSessionsOptions, "cursor"> = {}, maximumPages = 10_000): Promise<CollectedPages> {
  const sessions: RemoteSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let authoritative = true;
  do {
    const page = await adapter.listSessions({ ...options, ...(cursor !== undefined ? { cursor } : {}) });
    pages += 1;
    sessions.push(...page.sessions);
    authoritative = authoritative && page.authoritative !== false;
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error(`${adapter.providerId} repeated pagination cursor ${page.nextCursor}`);
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pages >= maximumPages) throw new Error(`${adapter.providerId} exceeded maximum page count ${maximumPages}`);
  } while (true);
  return { sessions, pages, authoritative };
}
