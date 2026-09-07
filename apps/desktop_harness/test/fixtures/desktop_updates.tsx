import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopUpdates } from "../../src/renderer/src/DesktopUpdates";
import { Sidebar } from "../../src/renderer/src/NavigationPanels";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/navigation.css";

const listeners = new Set<(state: any) => void>();
const initial: ((state: any) => void)[] = [];
const actions: string[] = [];
const idle = { phase: "idle", currentVersion: "0.1.1" };
const emit = (state: any) => { for (const listener of listeners) listener(state); };
(window as any).tethoqDesktop = {
  updateState: () => new Promise(resolve => initial.push(resolve)),
  onUpdateState: (listener: (state: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  updateAction: async (action: string) => {
    actions.push(action);
    if (action === "download") emit({ ...idle, phase: "downloading", version: "0.1.2", percent: 45 });
  },
};
const noop = () => {};
const root = createRoot(document.body.appendChild(document.createElement("div")));
root.render(<div className="desktop-app"><div style={{ height: 46, padding: "12px 16px" }}>Tethoq</div><div className="app-body">
  <Sidebar sessions={[]} allSessions={[]} providers={[]} selected={null} selectedProvider="all" query="" stateFilter="all" view="settings" connected={true} runtimeConnectionState="online" hostName="Update QA"
    onQuery={noop} onFilter={noop} onProvider={noop} onOpen={noop} onOpenChild={noop} onBranch={noop} onOpenDirectory={noop} onView={noop} onNewTask={noop} onNewTaskInProject={noop} onNewProject={noop}
    taskListMode="recent" onTaskListMode={noop} onCommandSearch={noop} onMobileConnection={noop} showSideChats={false} activeSideChatIds={[]} onShowSideChats={noop} onCreateSideChat={async () => {}} onOpenSideChat={noop} onSideChatAnchor={noop} showArchived={false} archivedCount={0} onShowArchived={noop} onTaskOverride={noop}/>
  <main className="settings-page settings-simplified"><DesktopUpdates /></main>
</div></div>);
const wait = async (predicate: () => unknown) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw Error("Update renderer did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const button = () => document.querySelector<HTMLButtonElement>(".desktop-updates button")!;
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
void (async () => {
  await wait(() => listeners.size === 2);
  emit({ ...idle, phase: "available", version: "0.1.2" });
  for (const resolve of initial) resolve(idle);
  await wait(() => button()?.textContent === "Download update");
  check(document.querySelector(".sidebar-settings")?.textContent?.includes("Update available"), "Sidebar did not announce the update");
  button().click();
  await wait(() => button().textContent === "Downloading 45%");
  check(button().disabled, "Download action was not disabled while downloading");
  emit({ ...idle, phase: "downloaded", version: "0.1.2" });
  await wait(() => button().textContent === "Restart to update");
  (window as any).__updateReady = true;
  await wait(() => (window as any).__updateContinue);
  button().click();
  await wait(() => actions.length === 2);
  check(actions.join(",") === "download,install", "Update buttons called the wrong main-process actions");
  emit({ ...idle, phase: "downloaded", version: "0.1.2", message: "Finish or stop running tasks before restarting for an update." });
  await wait(() => document.body.textContent?.includes("Finish or stop running tasks"));
  check(button().textContent === "Restart to update", "Deferred restart lost the ready update");
  emit({ ...idle, phase: "error", message: "The update could not be completed." });
  await wait(() => button().textContent === "Check for updates");
  button().click();
  await wait(() => actions.length === 3);
  check(actions[2] === "check", "Failed updates cannot retry");
  root.unmount();
  check(listeners.size === 0, "Update listeners leaked after unmount");
  (window as any).__updateResult = { ok: true };
})().catch(error => { (window as any).__updateResult = { ok: false, error: error.message }; });
