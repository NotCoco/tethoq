import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

test("interruption paints one neutral boundary without a live pulse, including after history refresh", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-stop-mounted-"));
  const artifacts = resolve(appRoot, "../../local-artifacts/opencode-stop-ui");
  await mkdir(artifacts, { recursive: true });
  const data = process.env.STOP_QA_TRANSCRIPT ? JSON.parse(await readFile(process.env.STOP_QA_TRANSCRIPT, "utf8")) : {
    sessionId: "stop-qa",
    events: [{ type: "agent.interrupted", providerId: "opencode", sessionId: "stop-qa", eventId: "stop", occurredAt: "2026-09-09T00:00:02.000Z", payload: { turnId: "prompt" } }],
    messages: [{ id: "opencode/answer", sessionId: "stop-qa", providerMessageId: "answer", role: "assistant", createdAt: "2026-09-09T00:00:01.000Z", completedAt: "2026-09-09T00:00:02.000Z", status: "failed", nativeMetadata: { parentID: "prompt" },
      parts: [{ type: "reasoning", text: "Inspecting the implementation", redacted: false }, { type: "error", code: "MessageAbortedError", message: "Aborted" }] }],
  };
  try {
    await writeFile(join(directory, "transcript.json"), JSON.stringify(data));
    await build({ stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {ChatTimeline} from './src/renderer/src/ChatTimeline';
      import {mapMessages,eventToTimeline} from './src/renderer/src/bridge';
      import {reconcileTimelinePage,mergeTimeline,settleRunningTimeline} from './src/renderer/src/timeline_merge';
      import './src/renderer/src/styles.css';
      const check=(value,message)=>{if(!value)throw new Error(message)};
      const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const root=createRoot(document.getElementById('root'));
      try {
        const data=await window.stopQa.data();
        const live=data.events.map(eventToTimeline).filter(Boolean).reduce(mergeTimeline,[]);
        let timeline=reconcileTimelinePage(mapMessages(data.messages),settleRunningTimeline(live,'failed'));
        const verify=()=>{
          check(document.querySelectorAll('[role=separator][aria-label="Task interrupted"]').length===1,'Exactly one interruption notice');
          check(!document.querySelector('[role=alert],.timeline-error-notice'),'A user interruption is not a red issue');
          check(!document.querySelector('.working-pulse,[aria-busy=true]'),'No reasoning pulse remains after Stop');
          check(!document.body.innerText.includes('Aborted'),'No duplicate raw Aborted error');
        };
        for(let i=0;i<6;i++){
          timeline=reconcileTimelinePage(mapMessages(data.messages),timeline);
          root.render(<ChatTimeline timeline={timeline} providerId="opencode" active={false}/>);
          await paint(); verify();
        }
        await window.stopQa.capture();
        console.log('STOP_UI_QA='+JSON.stringify({ok:true,notices:1,refreshes:6}));
      } catch(error){console.log('STOP_UI_QA='+JSON.stringify({ok:false,error:error.message}));}
    `, resolveDir: appRoot, loader: "tsx" }, outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" }, plugins: [{ name: "worker-stub", setup(context) {
      context.onResolve({ filter: /\?worker&inline$/ }, ({ path }) => ({ path, namespace: "worker-stub" }));
      context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class {}", loader: "js" }));
    } }] });
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><main id="root" style="max-width:850px;margin:32px auto"></main><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "preload.cjs"), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('stopQa',{data:()=>ipcRenderer.invoke('qa:data'),capture:()=>ipcRenderer.invoke('qa:capture')});");
    await writeFile(join(directory, "main.cjs"), `
      const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-gpu');
      app.whenReady().then(async()=>{
        const window=new BrowserWindow({show:false,width:1000,height:760,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,backgroundThrottling:false}});
        ipcMain.handle('qa:data',()=>JSON.parse(fs.readFileSync(path.join(__dirname,'transcript.json'),'utf8')));
        ipcMain.handle('qa:capture',async()=>{
          await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Paint timed out')),2000);window.webContents.once('paint',()=>{clearTimeout(timer);resolve()});window.webContents.invalidate()});
          fs.writeFileSync(path.join(process.argv[2],'interrupted.png'),(await window.webContents.capturePage()).toPNG());
        });
        window.webContents.on('console-message',(_event,_level,message)=>{if(message.startsWith('STOP_UI_QA=')){console.log(message);app.exit(0)}});
        await window.loadFile(path.join(__dirname,'index.html'));
      }).catch(error=>{console.error(error);app.exit(1)});
    `);
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(electronPath, [join(directory, "main.cjs"), artifacts], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      const timer = setTimeout(() => child.kill(), 20_000);
      child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer);
        const line = output.split(/\r?\n/u).find(line => line.startsWith("STOP_UI_QA="));
        if (code !== 0 || !line) reject(new Error(`Stop UI QA exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(line.slice("STOP_UI_QA=".length)));
      });
    });
    assert.equal(result.ok, true, result.error);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
