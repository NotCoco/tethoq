import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../../src/renderer/src/styles.css";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const envelope = (sessions: unknown[]) => ({ ok: true, payload: { sessions } });
const reads: Record<string, number> = {};
const gates = new Map<string, ReturnType<typeof deferred>>();
window.tethoqDesktop = {
  request: async (type: string, payload: Record<string, unknown>) => {
    const id = String(payload.sessionId);
    const key = `${type}:${id}`;
    reads[key] = (reads[key] ?? 0) + 1;
    if (type === "session.children") return gates.get(id)?.promise ?? envelope([]);
    if (type === "session.side_chats") return envelope([{ id: `${id}-side`, title: `Side chat ${id}`, providerId: "codex", state: "idle", updatedAt: "2026-09-08T00:00:00Z" }]);
    if (type === "vision.targets") return { ok: true, payload: { targets: [] } };
    if (type === "session.vision.get") return { ok: true, payload: { vision: { sessionId: id, configured: false, enabled: false, state: "unconfigured" } } };
    return { ok: true, payload: {} };
  },
} as never;

const [{ TaskDetailsControl, resolveTimelineSubagentSession }, { SessionSubagentControl }, metadata] = await Promise.all([
  import("../../src/renderer/src/App"),
  import("../../src/renderer/src/NavigationPanels"),
  import("../../src/renderer/src/session_metadata"),
]);
const provider = { id: "codex", name: "Codex", state: "online", detected: true, authenticated: true, supportsAttachments: true, capabilities: [] } as const;
const session = (id: string) => ({ id, title: `Task ${id}`, childCount: 1, providerId: "codex", state: "idle" as const, project: "qa", workingDirectory: "C:\\qa", preview: "", model: "gpt-5.6-sol", effort: "high", updatedAt: "2026-09-08T00:00:00Z" });
const child = (id: string, title = `Worker ${id}`, state = "idle") => ({
  id: `${id}-child`, title, providerId: "codex", providerSessionId: `${id}-child`, hostId: "qa", state,
  lastActivityAt: "2026-09-08T00:00:00Z", workingDirectory: "C:\\qa", modelId: "gpt-5.6-sol", reasoningEffort: "high", nativeMetadata: {},
  parentSessionId: id, relationship: { kind: "subagent", sourceSessionId: id },
});
const node = document.createElement("div");
node.style.cssText = "padding:80px 100px;position:relative";
document.body.append(node);
const root = createRoot(node);
const render = async (id: string, details = true, childCount = 1) => {
  const current = { ...session(id), childCount };
  flushSync(() => root.render(<>
    <div style={{ position: "relative", width: 200, height: 80 }}><SessionSubagentControl session={current} providers={[provider]} onOpenChild={() => undefined} /></div>
    {details ? <TaskDetailsControl session={current} providers={[provider]} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents onSessionForeignSubagents={() => undefined} /> : null}
  </>));
  await settle();
};
const click = (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  check(button, `${selector} is missing`);
  flushSync(() => button!.click());
};
const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";

try {
  const first = deferred();
  gates.set("a", first);
  await render("a");
  check(reads["session.children:a"] === 1, "Selecting the task did not preload child names");
  check(reads["session.side_chats:a"] === 1, "Selecting the task did not preload side chats");
  metadata.reconcileSessionMetadata({ latestSequence: 1, replayGap: false, events: [{ sequence: 1, eventId: "parent-working", type: "session.status_changed", sessionId: "a", payload: { state: "working" } }] } as never);
  first.resolve(envelope([child("a")]));
  await settle();
  const start = performance.now();
  click(".session-subagents-trigger");
  check(text(".session-subagents-popover").includes("Worker a"), "Sidebar did not paint cached names on the opening render");
  check(!text(".session-subagents-popover").includes("Loading"), "Sidebar flashed loading for a cached task");
  const sidebarMs = performance.now() - start;
  click(".task-details-trigger");
  check(text(".task-child-list").includes("Worker a"), "Info panel did not share the sidebar's cached child list");
  check(text(".task-details-popover").includes("Side chat a"), "Info panel did not immediately paint cached side chats");
  check(reads["session.children:a"] === 1, "The two controls repeated the preload request");
  await settle();
  metadata.childSessionCache.invalidate("a");
  const fromTimeline = await resolveTimelineSubagentSession("a", "a-child", []);
  check(fromTimeline?.title === "Worker a" && reads["session.children:a"] === 1, "A timeline link waited for a cached child's metadata");

  // Switch away and back while a refresh is deliberately withheld. The first
  // render must still contain the recent task's own names, never the other task.
  gates.set("b", deferred());
  await render("b");
  click(".task-details-trigger");
  check(!text(".task-details-popover").includes("Worker a"), "Previous task names leaked into a cold task");
  await render("a");
  const refresh = deferred();
  gates.set("a", refresh);
  metadata.childSessionCache.invalidate("a");
  click(".session-subagents-trigger");
  // The sidebar control is intentionally reused across sessions by this test.
  if (!document.querySelector(".session-subagents-popover")) click(".session-subagents-trigger");
  check(text(".session-subagents-popover").includes("Worker a"), "Reopening a recent task waited for the refresh");
  click(".task-details-trigger");
  check(text(".task-child-list").includes("Worker a"), "Reopened info panel blanked its cached names");
  await settle();
  refresh.resolve(envelope([child("a", "Renamed worker", "working")]));
  await settle();
  check(text(".session-subagents-popover").includes("Renamed worker"), "Sidebar did not receive the refreshed title");
  check(text(".task-child-list").includes("Renamed worker"), "Info panel did not receive the shared refreshed title");

  // Live child events invalidate the owner, including cross-provider children.
  const stopped = deferred();
  gates.set("a", stopped);
  metadata.reconcileSessionMetadata({ latestSequence: 1, replayGap: false, events: [{ sequence: 1, eventId: "done", type: "session.status_changed", providerId: "codex", sessionId: "a-child", occurredAt: "2026-09-08T00:00:01Z", payload: { state: "completed" } }] } as never);
  const liveRefresh = metadata.childSessionCache.load("a");
  stopped.resolve(envelope([child("a", "Renamed worker", "completed")]));
  await liveRefresh;
  await settle();
  check(text(".session-subagent-state").includes("Completed"), "Completed child status stayed stale");
  check(text(".task-child-list").includes("Completed"), "Task details did not update live");

  const offline = deferred();
  gates.set("a", offline);
  const failedRefresh = metadata.childSessionCache.load("a", true).catch(() => undefined);
  offline.reject(new Error("Provider offline"));
  await failedRefresh;
  await settle();
  check(text(".task-child-list").includes("Renamed worker"), "Refresh failure removed usable cached names");

  const newChild = { ...child("a", "New worker"), id: "new-child" };
  gates.set("a", deferred());
  const openNew = resolveTimelineSubagentSession("a", "new-child", []);
  gates.get("a")!.resolve(envelope([child("a"), newChild]));
  check((await openNew)?.id === "new-child", "A freshly spawned child was hidden by an older cached inventory");

  // Closing/removing controls must stop polling, including the former task.
  click(".session-subagents-trigger");
  click(".task-details-trigger");
  const oldInventory = deferred();
  gates.set("changing", oldInventory);
  await render("changing");
  const newInventory = deferred();
  gates.set("changing", newInventory);
  await render("changing", true, 2);
  oldInventory.resolve(envelope([child("changing")]));
  await settle();
  check(reads["session.children:changing"] === 2, "A child-count change did not replace discovery already in flight");
  newInventory.resolve(envelope([child("changing"), { ...child("changing"), id: "second-child" }]));
  await settle();
  check(metadata.childSessionCache.getSnapshot("changing").data?.length === 2, "An earlier inventory hid a newly spawned child");
  await render("c", false);
  check(!reads["session.children:c"], "Merely listing a cold task triggered a provider scan");
  click(".session-subagents-trigger");
  check(text(".session-subagents-popover").includes("Loading"), "Uncached sidebar task did not show its loading state");
  await settle();
  flushSync(() => root.unmount());
  gates.get("b")!.resolve(envelope([child("b")]));
  await settle();
  const before = JSON.stringify(reads);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  check(JSON.stringify(reads) === before, "Unmounted metadata controls kept polling");
  metadata.childSessionCache.clear();
  metadata.sideChatCache.clear();
  (window as any).__metadataResult = { ok: true, sidebarMs, childReads: reads["session.children:a"] };
} catch (error) {
  (window as any).__metadataResult = { ok: false, error: error instanceof Error ? error.stack : String(error) };
}
