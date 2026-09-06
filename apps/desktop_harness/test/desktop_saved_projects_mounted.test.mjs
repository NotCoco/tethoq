import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

test("saved project rail limits folders, stays stable, and separates harness, sub-agents, and title", { timeout: 40_000 }, async () => {
  const output = join(tmpdir(), `tethoq-saved-projects-${process.pid}-${Date.now()}`);
  const captures = join(appRoot, "qa-artifacts", "saved-projects");
  await mkdir(output, { recursive: true });
  await mkdir(captures, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot, sourcefile: "saved-projects.tsx", loader: "tsx",
        contents: String.raw`
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { Sidebar } from "./src/renderer/src/NavigationPanels";
          import "./src/renderer/src/styles.css";
          import "./src/renderer/src/navigation.css";
          window.tethoqDesktop = { request: async () => ({ ok: true, payload: { sessions: [] } }) };
          const folders = ["C:\\Projects\\workspace", "C:\\Projects\\Ideas", "C:\\Projects\\Backend", "C:\\Projects\\Design", "C:\\Projects\\private", "C:\\Projects\\game", "C:\\Projects\\empty"];
          const providers = ["codex", "opencode", "pi"].map(id => ({ id, name: id === "opencode" ? "OpenCode" : id === "codex" ? "Codex" : "Pi", detected: true, state: "online", capabilities: [] }));
          const session = (id, directory, providerId = "codex", childCount = 0) => ({ id, providerId, title: id === "count-2" ? "Short task title" : id.startsWith("count") ? "Review the project and verify the latest changes" : id, workingDirectory: directory, project: directory.split("\\").at(-1), updatedAt: "2026-09-06T10:00:00.000Z", state: childCount === 130 ? "working" : "idle", preview: "", model: "model", effort: "high", childCount });
          const initial = [
            ...[2, 23, 130, 1000].map((count, index) => session("count-" + count, folders[0], providers[index % 3].id, count)),
            session("Native OpenCode task", folders[1], "opencode"), session("Native Codex task", folders[1]), session("Native Pi task", folders[1], "pi"),
            ...folders.slice(2, -1).map(folder => session(folder.split("\\").at(-1) + " task", folder)),
            session("Ordinary chat", "C:\\Users\\example\\Codex\\chats"),
          ];
          function Fixture() {
            const [saved, setSaved] = useState(folders);
            const [sessions, setSessions] = useState(initial);
            const [selected, setSelected] = useState("count-2");
            const [mode, setMode] = useState("project");
            const [query, setQuery] = useState("");
            window.projectQa = {
              ready: true, setQuery,
              setCount: count => setSessions(current => current.map(session => session.id === "count-2" ? { ...session, childCount: count } : session)),
              addNativeTask: () => setSessions(current => [session("Fresh OpenCode task", folders[2], "opencode"), ...current]),
            };
            return <div className="app-body" style={{height:"100vh"}}><Sidebar
              sessions={sessions.filter(s => !query || s.title.toLowerCase().includes(query.toLowerCase()))} allSessions={sessions} providers={providers}
              selected={selected} selectedProvider="all" query={query} stateFilter="all" view="workspace" connected runtimeConnectionState="online" hostName="QA"
              taskListMode={mode} savedProjectDirectories={saved} onTaskListMode={setMode}
              onQuery={setQuery} onFilter={() => {}} onProvider={() => {}} onOpen={id => { setSelected(id); const directory = sessions.find(s => s.id === id).workingDirectory; if (saved.includes(directory)) setSaved([directory, ...saved.filter(p => p !== directory)]); }}
              onNewTaskInProject={directory => { const draft = { ...session("New task", directory), id: "draft-test", draft: true }; setSessions(current => [draft, ...current]); setSelected(draft.id); }}
              onNewProject={() => {}} onNewTask={() => {}} onOpenChild={() => {}} onBranch={() => {}} onOpenDirectory={() => {}} onView={() => {}}
              onCommandSearch={() => {}} onMobileConnection={() => {}} showSideChats={false} activeSideChatIds={[]} onShowSideChats={() => {}}
              onCreateSideChat={async () => {}} onOpenSideChat={() => {}} onSideChatAnchor={() => {}} showArchived={false} archivedCount={0} onShowArchived={() => {}} onTaskOverride={() => {}}
            /><main style={{padding:32}}><h1>Saved projects</h1><p>Each task keeps the harness that created it.</p></main></div>;
          }
          createRoot(document.getElementById("root")).render(<Fixture />);
        `,
      },
      outfile: join(output, "renderer.js"), bundle: true, format: "esm", platform: "browser", target: "chrome136", loader: { ".png": "dataurl" },
    });
    await writeFile(join(output, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(output, "main.cjs"), String.raw`
      const { app, BrowserWindow } = require("electron");
      const { writeFile } = require("node:fs/promises");
      const path = require("node:path");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.on("window-all-closed", () => {});
      app.whenReady().then(async () => {
        const results = [];
        for (const [width, height, railWidth] of [[1100, 760, 248], [800, 560, 220]]) {
          const window = new BrowserWindow({ width, height, x: -10000, y: -10000, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
          await window.loadFile(path.join(__dirname, "index.html"));
          await window.webContents.executeJavaScript('new Promise(resolve => { const check = () => window.projectQa?.ready && document.querySelector(".session-project-group") ? resolve() : setTimeout(check, 10); check(); })');
          await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--navigation-panel", "' + railWidth + 'px")');
          const result = await window.webContents.executeJavaScript('(' + (async () => {
            const settle = () => new Promise(resolve => requestAnimationFrame(resolve));
            const check = (condition, message) => { if (!condition) throw new Error(message); };
            const order = () => [...document.querySelectorAll(".session-project-group")].map(group => group.dataset.projectKey);
            await settle();
            const before = order();
            check(before.length === 3, "Expected three projects initially");
            check(!document.body.textContent.includes("Ordinary chat"), "A scratch-folder chat appeared as a project");
            const group = [...document.querySelectorAll(".session-project-group")][1];
            check(new Set([...group.querySelectorAll(".session-row .provider-logo")].map(icon => icon.dataset.providerId)).size === 3, "Tasks from three harnesses did not share a saved folder");
            const geometry = [];
            for (const shell of document.querySelectorAll('.session-row-shell:has(.session-subagents.compact)')) {
              const icon = shell.querySelector(".session-project-harness").getBoundingClientRect();
              const subagent = shell.querySelector(".session-subagents-trigger").getBoundingClientRect();
              const title = shell.querySelector(".session-project-row-title").getBoundingClientRect();
              const row = shell.querySelector(".session-row").getBoundingClientRect();
              const status = shell.querySelector(".session-project-working-indicator")?.getBoundingClientRect();
              check(icon.right <= subagent.left, "Harness overlaps sub-agent control");
              check(title.left - subagent.right >= 7.9, "Sub-agent button needs a character of clear space before the title");
              check(icon.width === 24 && icon.left < 20, "Harness logo did not grow or move left");
              check(title.width > 45 && row.height === 31, "Compact task has no readable title lane");
              check(!status || title.right <= status.left, "Working spinner overlaps title");
              geometry.push({ count: shell.querySelector(".session-subagents-count").textContent, iconLeft: icon.left, subagentLeft: subagent.left, subagentWidth: subagent.width, titleGap: title.left - subagent.right, titleLeft: title.left, titleWidth: title.width });
            }
            check(geometry.length === 4, "Missing count fixtures");
            check(geometry[1].subagentWidth > geometry[0].subagentWidth && geometry[2].subagentWidth > geometry[1].subagentWidth, "The button does not grow with the count");
            window.projectQa.setCount(23); await settle();
            const grown = document.querySelector('[data-session-id="count-2"]');
            const grownButton = grown.querySelector('.session-subagents-trigger').getBoundingClientRect();
            const grownTitle = grown.querySelector('.session-project-row-title').getBoundingClientRect();
            check(grownButton.width > geometry[0].subagentWidth && grownTitle.left - grownButton.right >= 7.9, "A live count change lost the title gap");
            window.projectQa.setCount(2); await settle();
            group.querySelector(".session-row").click(); await settle();
            window.projectQa.addNativeTask(); await settle();
            check(JSON.stringify(order()) === JSON.stringify(before), "Activity reordered visible project folders");
            document.querySelector(".session-projects-disclosure").click(); await settle();
            check(order().length === 7, "Show all did not reveal every saved folder");
            const empty = [...document.querySelectorAll(".session-project-group")].find(g => g.querySelector("strong").textContent === "empty");
            check(empty && !empty.querySelector(".session-row"), "Empty saved project disappeared");
            document.querySelector(".session-projects-disclosure").click(); await settle();
            document.querySelector('.session-project-group .session-project-new-task').click(); await settle();
            const draft = document.querySelector('[data-session-id="draft-test"]');
            check(draft && !draft.querySelector("[data-provider-id]") && draft.querySelector(".session-draft-harness"), "Unsent draft claimed a harness");
            check(JSON.stringify(order()) === JSON.stringify(before), "A new draft moved its project");
            document.querySelector('button[aria-label="Arrange tasks by recency"]').click(); await settle();
            check(document.body.textContent.includes("Ordinary chat"), "Recent lost ordinary chats");
            document.querySelector('button[aria-label="Arrange tasks by project"]').click(); await settle();
            return { width: innerWidth, projects: before, geometry };
          }).toString() + ')()');
          await new Promise(resolve => setTimeout(resolve, 500));
          await writeFile(path.join(process.argv[2], "projects-" + width + ".png"), (await window.webContents.capturePage()).toPNG());
          // The QA window stays hidden; exercise the real hover rule through Chromium.
          window.webContents.debugger.attach("1.3");
          await window.webContents.debugger.sendCommand("DOM.enable");
          await window.webContents.debugger.sendCommand("CSS.enable");
          const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
          for (const id of ["count-2", "count-23"]) {
            const target = await window.webContents.executeJavaScript('(() => { const shell = document.querySelector("[data-session-id=' + id + ']"); const button = shell.querySelector(".session-subagents-trigger").getBoundingClientRect(); const row = shell.getBoundingClientRect(); return { x: button.x + button.width / 2, y: button.y + button.height / 2, top: row.top }; })()');
            const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-session-id="' + id + '"] .session-subagents-trigger' });
            await window.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
            await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const hoverBackground = await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-session-id=' + id + '] .session-subagents-trigger")).backgroundColor');
            if (hoverBackground !== "rgb(41, 41, 39)") throw new Error("Sub-agent hover styling did not apply");
            await writeFile(path.join(process.argv[2], "hover-" + id + "-" + width + ".png"), (await window.webContents.capturePage({ x: 0, y: Math.floor(target.top) - 4, width: railWidth, height: 40 })).toPNG());
            await window.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
          }
          window.webContents.debugger.detach();
          results.push(result);
          window.destroy();
        }
        process.stdout.write("SAVED_PROJECTS_QA=" + JSON.stringify(results) + "\n");
        app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const results = await new Promise((resolve, reject) => {
      const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronPath, [join(output, "main.cjs"), captures], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Saved-project QA timed out: " + stderr)); }, 35_000);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("exit", code => {
        clearTimeout(timeout);
        const marker = stdout.split(/\r?\n/u).find(line => line.startsWith("SAVED_PROJECTS_QA="));
        if (code !== 0 || !marker) reject(new Error(`Saved-project QA failed (${code}): ${stderr}\n${stdout}`));
        else resolve(JSON.parse(marker.slice("SAVED_PROJECTS_QA=".length)));
      });
    });
    assert.equal(results.length, 2);
    await writeFile(join(captures, "results.json"), JSON.stringify(results, null, 2));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
