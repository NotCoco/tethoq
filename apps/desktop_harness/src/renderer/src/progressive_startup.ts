import type { DesktopSnapshot, Provider, Session } from "./types";

export const progressiveStartupDraftId = "draft-startup";

export type PresentedNavigationView = "workspace" | "dashboard" | "browser" | "settings";
export type RuntimeConnectionPresentation = "starting" | "online" | "offline" | "failed";

export function presentedRuntimeConnectionState(input: {
  readonly runtimeState: "starting" | "ready" | "stopping" | "failed";
  readonly connected: boolean;
  readonly loading: boolean;
}): RuntimeConnectionPresentation {
  if (input.runtimeState === "failed") return input.loading ? "failed" : "offline";
  if (input.loading || input.runtimeState === "starting") return "starting";
  return input.connected ? "online" : "offline";
}

export function presentedNavigationView(view: PresentedNavigationView, hasSelectedSession: boolean): PresentedNavigationView {
  return view === "workspace" && !hasSelectedSession ? "dashboard" : view;
}

export function progressiveStartupSnapshot(now = new Date().toISOString()): DesktopSnapshot {
  const provider: Provider = {
    id: "codex",
    name: "Codex",
    state: "offline",
    detected: false,
    authenticated: false,
    capabilities: ["Create Session", "Send Message", "Session History"],
    supportsAttachments: true,
  };
  return {
    connected: false,
    loading: true,
    hostName: "This computer",
    providers: [provider],
    sessions: [{
      id: progressiveStartupDraftId,
      draft: true,
      provisional: true,
      providerId: provider.id,
      title: "New task",
      state: "idle",
      project: "",
      workingDirectory: "",
      preview: "",
      updatedAt: now,
      model: "default",
      effort: "",
    }],
    timelines: {},
    approvals: [],
    inputRequests: [],
    models: {},
    goals: {},
    goalClearRevisions: {},
  };
}

export function retainedStartupDraftSessions(
  shellSessions: readonly Session[],
  hydratedSnapshot: DesktopSnapshot,
  firstSession: Session | undefined,
  hasDraftPayload: (sessionId: string) => boolean,
): Session[] {
  const retained = shellSessions.filter((session) => session.draft === true
    && (session.id !== progressiveStartupDraftId || hasDraftPayload(session.id)));
  const canCreate = (provider: Provider) => provider.detected
    && provider.capabilities.includes("Create Session")
    && provider.capabilities.includes("Send Message");
  const preferredProvider = hydratedSnapshot.providers.find((provider) => provider.id === firstSession?.providerId && canCreate(provider))
    ?? hydratedSnapshot.providers.find((provider) => provider.authenticated && canCreate(provider))
    ?? hydratedSnapshot.providers.find(canCreate)
    ?? hydratedSnapshot.providers[0];
  return retained.map((draft) => {
    const retainedProvider = hydratedSnapshot.providers.find((provider) => provider.id === draft.providerId);
    const provider = retainedProvider ?? preferredProvider;
    const workingDirectory = draft.workingDirectory || firstSession?.workingDirectory || "";
    return {
      ...draft,
      provisional: provider === undefined,
      ...(provider ? { providerId: provider.id } : {}),
      workingDirectory,
      project: workingDirectory.split(/[\\/]/u).filter(Boolean).at(-1) ?? draft.project,
    };
  });
}

export function selectedSessionAfterStartupHydration(
  currentSelection: string | null,
  retainedDrafts: readonly Session[],
  hydratedSessions: readonly Session[],
): string | null {
  if (!currentSelection) return null;
  const availableIds = new Set([...retainedDrafts, ...hydratedSessions].map((session) => session.id));
  return availableIds.has(currentSelection) ? currentSelection : null;
}

export function resolvedStartupDraftTimelines(
  timelines: DesktopSnapshot["timelines"],
  retainedDrafts: readonly Session[],
): DesktopSnapshot["timelines"] {
  if (!retainedDrafts.length) return timelines;
  const next = { ...timelines };
  for (const draft of retainedDrafts) next[draft.id] ??= [];
  return next;
}
