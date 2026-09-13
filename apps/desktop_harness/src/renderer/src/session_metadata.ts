import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { DesktopEventBatch } from "@shared/desktop_api";
import { listChildSessions, request } from "./bridge";
import { RecentSessionCache } from "./recent_session_cache";
import type { Session } from "./types";

const metadataPolicy = {
  maxEntries: 24,
  maxBytes: 4 * 1024 * 1024,
  freshMs: 1_500,
  idleMs: 10 * 60_000,
  concurrency: 2,
};

export interface SideChatSummary {
  id: string;
  title: string;
  providerId: string;
  state: string;
  updatedAt: string;
  preview?: string;
}

export const childSessionCache = new RecentSessionCache(listChildSessions, metadataPolicy);
export const sideChatCache = new RecentSessionCache(async (sessionId) => {
  const result = await request("session.side_chats", { sessionId });
  if (!Array.isArray(result.sessions)) throw new Error("Invalid side-chat list");
  return result.sessions as unknown as SideChatSummary[];
}, { ...metadataPolicy, maxBytes: 1024 * 1024, freshMs: 5_000 });

export function useSessionMetadata<T>(cache: RecentSessionCache<T>, sessionId: string, enabled: boolean, live: boolean) {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(sessionId, listener), [cache, sessionId]);
  const read = useCallback(() => cache.getSnapshot(sessionId), [cache, sessionId]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (!enabled) return;
    const release = cache.retain(sessionId);
    void cache.load(sessionId).catch(() => undefined);
    return release;
  }, [cache, enabled, sessionId]);
  useEffect(() => {
    if (!enabled || !live) return;
    const refresh = () => {
      if (!document.hidden) void cache.load(sessionId).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [cache, enabled, live, sessionId]);
  return snapshot;
}

/** The selected task warms its child names even before either panel is open. */
export function useTaskChildren(session: Session, enabled: boolean, live: boolean) {
  const previous = useRef({ id: session.id, count: session.childCount });
  useEffect(() => {
    const countChanged = previous.current.id === session.id && previous.current.count !== session.childCount;
    previous.current = { id: session.id, count: session.childCount };
    if (!enabled && !countChanged) return;
    const children = childSessionCache.getSnapshot(session.id).data;
    if (countChanged || (children && session.childCount !== undefined && children.length !== session.childCount)) {
      childSessionCache.invalidate(session.id);
      if (enabled) void childSessionCache.load(session.id).catch(() => undefined);
    }
  }, [enabled, session.id, session.childCount]);
  return useSessionMetadata(childSessionCache, session.id, enabled, live);
}

export function reconcileSessionMetadata(batch: DesktopEventBatch): void {
  if (batch.replayGap || batch.events.some((event) => event.type === "host.connected" || event.type === "host.disconnected" || event.type === "provider.connected" || event.type === "provider.disconnected")) {
    childSessionCache.invalidateAll();
    sideChatCache.invalidateAll();
  }
  const changed = new Set(batch.events.flatMap((event) => event.sessionId && (
    event.type === "session.created" || event.type === "session.updated" || event.type === "session.status_changed"
      || event.type.startsWith("agent.") || event.type.startsWith("delegation.") || event.type.startsWith("side_chat.")
  ) ? [event.sessionId] : []));
  const owners = new Set<string>();
  for (const event of batch.events) {
    if (event.type.startsWith("delegation.") && event.sessionId) owners.add(event.sessionId);
    if (event.type === "session.updated" && event.payload.childCount !== undefined && event.sessionId) owners.add(event.sessionId);
    const raw = event.payload.session;
    const parentId = event.payload.sourceSessionId ?? event.payload.parentSessionId
      ?? (raw && typeof raw === "object" && !Array.isArray(raw) ? raw.parentSessionId : undefined);
    if (typeof parentId === "string") owners.add(parentId);
  }
  // A parent's ordinary status/vision/goal events do not change its children.
  // Invalidating on those can starve a slow discovery while the task is active.
  for (const id of owners) {
    childSessionCache.invalidate(id);
    sideChatCache.invalidate(id);
  }
  childSessionCache.forEach((children, parentId) => {
    if (children.some((child) => changed.has(child.id))) childSessionCache.invalidate(parentId);
  });
  sideChatCache.forEach((children, parentId) => {
    if (children.some((child) => changed.has(child.id))) sideChatCache.invalidate(parentId);
  });
}

export function maintainSessionMetadata(): () => void {
  const timer = window.setInterval(() => { childSessionCache.sweep(); sideChatCache.sweep(); }, 60_000);
  return () => {
    window.clearInterval(timer);
    childSessionCache.clear();
    sideChatCache.clear();
  };
}
