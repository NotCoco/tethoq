import { useEffect, useState } from "react";
import type { DesktopBootstrap } from "@shared/desktop_api";
import { HARNESS_GUIDES, harnessSetupPrompt } from "@shared/harness_setup";
import { isBrowserPreview } from "./bridge";
import { CopyIcon, FolderIcon, RefreshIcon } from "./icons";
import type { DesktopSnapshot } from "./types";
import "./harness-connections.css";

export function HarnessConnections({ snapshot, bootstrap, selected, onSelect, onReconnect, onDirectApiSetup, notify }: {
  snapshot: DesktopSnapshot;
  bootstrap?: DesktopBootstrap;
  selected: string;
  onSelect: (id: string) => void;
  onReconnect: (id: string) => Promise<void>;
  onDirectApiSetup: () => void;
  notify: (message: string, tone?: "normal" | "error") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState(bootstrap?.providerSetupIssues ?? []);
  useEffect(() => { setIssues(bootstrap?.providerSetupIssues ?? []); }, [bootstrap?.providerSetupIssues]);
  const guide = HARNESS_GUIDES.find((item) => item.id === selected) ?? HARNESS_GUIDES.find((item) => item.id === "other")!;
  const provider = snapshot.providers.find((item) => item.id === guide.id);
  const issue = issues.find((item) => item.providerId === guide.id);
  const prompt = harnessSetupPrompt(guide.id, bootstrap ? {
    connectorDirectory: bootstrap.connectors.directory,
    platform: bootstrap.app.platform,
    ...(!isBrowserPreview ? { packaged: bootstrap.app.packaged } : {}),
  } : {});
  const ready = provider?.state === "online" && provider.authenticated && !issue;
  const state = guide.id === "other" ? "Connector setup" : issue ? "Tool setup needs attention" : ready ? "Connected" : provider?.detected ? "Check sign-in or connection" : "Not connected";
  const copy = async () => {
    try {
      if (isBrowserPreview) await navigator.clipboard.writeText(prompt);
      else if (!await window.tethoqDesktop.copyText(prompt)) throw new Error("Clipboard unavailable");
      notify(`${guide.name} setup prompt copied`);
    } catch { notify("Could not copy. Select the prompt text below and copy it manually.", "error"); }
  };
  const retry = async () => {
    setBusy(true);
    try {
      await onReconnect(guide.id);
      if (!isBrowserPreview) setIssues((await window.tethoqDesktop.bootstrap()).providerSetupIssues ?? []);
    } catch { notify("Connection check failed. Follow the setup steps below, then retry.", "error"); }
    finally { setBusy(false); }
  };
  return <section className="settings-block harness-connections" id="harness-connections">
    <header><div><h2>Harness connections</h2><p>Tethoq connects to installed coding tools when it starts. Choose one for setup help.</p></div></header>
    <div className="harness-connection-card">
      <div className="harness-connection-picker"><label htmlFor="harness-choice">Harness</label><select id="harness-choice" value={guide.id} onChange={(event) => onSelect(event.target.value)}>{HARNESS_GUIDES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span className={ready ? "harness-status ready" : "harness-status"} role="status">{state}</span></div>
      <p>{guide.connection}</p>
      {provider?.connectionError ? <p className="harness-setup-issue">{provider.connectionError}</p> : null}
      {issue ? <p className="harness-setup-issue" role="alert">{issue.message}</p> : null}
      {guide.command ? <ol><li>Install the harness and complete its sign-in or model-provider setup.</li><li>Check that <code>{guide.command} --version</code> works in a terminal. If you just installed it, fully quit Tethoq from its tray menu and reopen it to refresh PATH.</li><li>Retry the connection, then select a model under Agents and start a task.</li></ol> : null}
      <div className="harness-connection-actions">
        {guide.id !== "other" && guide.documentation.startsWith("https://") ? <button type="button" disabled={isBrowserPreview} onClick={() => { if (guide.id !== "other") void window.tethoqDesktop.openHarnessSetupPage(guide.id).catch(() => notify("Could not open the setup guide", "error")); }}>Installation guide</button> : null}
        {guide.id === "direct" ? <button type="button" onClick={onDirectApiSetup}>Set up API key</button> : guide.id !== "other" ? <button type="button" disabled={busy} onClick={() => void retry()}><RefreshIcon /><span>{busy ? "Checking…" : "Retry connection"}</span></button> : bootstrap ? <button type="button" disabled={isBrowserPreview} onClick={() => { void window.tethoqDesktop.revealPath(bootstrap.connectors.directory).catch(() => notify("Could not open the connector folder", "error")); }}><FolderIcon /><span>Open connector folder</span></button> : null}
        <button type="button" onClick={() => void copy()}><CopyIcon /><span>Copy setup prompt</span></button>
      </div>
      <details className="harness-setup-details"><summary>Connection details &amp; setup prompt</summary>
        {guide.command ? <p>Protocol launch: <code>{guide.command} {guide.args?.join(" ")}</code></p> : null}
        <p>{guide.tools}</p><p>Give this prompt to a coding agent with access to this computer. {bootstrap && !isBrowserPreview ? bootstrap.app.packaged ? "It includes setup instructions for your installed app." : "It includes setup instructions for your source checkout." : "It asks the agent to identify your installation before setup."}</p>
        <textarea aria-label={`${guide.name} setup prompt`} readOnly value={prompt} spellCheck={false} />
      </details>
    </div>
  </section>;
}
