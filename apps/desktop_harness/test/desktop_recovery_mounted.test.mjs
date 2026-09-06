import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

test("mounted task recovery sends once, preserves composition, and keeps Eyes animated until settled", { timeout: 45_000 }, async () => {
  const directory = join(tmpdir(), `tethoq-recovery-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  try {
    await build({
      entryPoints: [join(appRoot, "test/fixtures/desktop_recovery.tsx")], outfile: join(directory, "renderer.js"),
      bundle: true, format: "esm", platform: "browser", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" },
      plugins: [{ name: "mounted-workspace", setup(context) {
        context.onLoad({ filter: /[\\/]App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, "utf8") + "\nexport { Workspace };", loader: "tsx" }));
        context.onResolve({ filter: /\?worker&inline$/ }, ({ path }) => ({ path, namespace: "worker-stub" }));
        context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class { addEventListener() {} postMessage() {} terminate() {} }", loader: "js" }));
      } }],
    });
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>#root > .workspace{height:100vh}</style></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
    const checks = async () => {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 10)); };
      for (let i = 0; !window.qa?.stage && i < 100; i++) await new Promise(r => setTimeout(r, 20));
      await settle();
      const qa = window.qa;
      const recovery = () => document.querySelector(".timeline-error-recovery");
      const running = () => document.querySelectorAll(".reasoning-running").length;
      const userRows = () => qa.snapshot.timelines["qa-session"].filter(i => i.body === "continue");
      recovery().click(); recovery().click();
      await settle();
      check(qa.calls.length === 1, "rapid Continue clicks sent duplicate requests");
      check(recovery().disabled && recovery().textContent === "Continuing…", "pending send is not visible or disabled");
      check(qa.calls[0].type === "session.continue" && !("content" in qa.calls[0].payload), "Continue did not use the internal continuation action");
      check(qa.calls[0].payload.modelId === "deepseek/deepseek-v4-pro" && qa.calls[0].payload.reasoningEffort === "high", "Continue changed model or effort");
      qa.pending("Provider unavailable"); await settle();
      check(qa.notifications.includes("Provider unavailable") && !recovery().disabled && !userRows().length, "rejection must remain visible and retryable without a success row");
      recovery().click(); await settle();
      qa.echo(); await settle(); qa.pending(); await settle();
      check(qa.calls.length === 2 && !userRows().length, "Continue exposed a control message");
      check(document.querySelectorAll(".message-user").length === 1, "the normalized control echo created a visible user row");
      check(qa.snapshot.sessions[0].state === "working" && !qa.stop, "Continue did not restart the task or clear Stop");
      check(!recovery(), "accepted continuation left its old action available");
      qa.status("idle"); await settle();
      check(!recovery(), "an idle status revived the accepted continuation before output arrived");
      check(document.getElementById("composer-message").value === "Keep this unsent draft." && qa.attachments[0].name === "draft.txt", "Continue consumed the existing composition");
      qa.stage("interrupted"); await settle(); recovery().click(); await settle();
      qa.echo(); qa.final(); await settle(); qa.pending(); await settle();
      check(qa.snapshot.sessions[0].state === "completed" && !running(), "a late send acknowledgement revived an already completed turn");
      check(document.body.textContent.includes("The image shows a two-way conversation."), "Continue hid the resumed assistant response");
      check(!recovery(), "completed work revived an old Continue button");
      qa.typedContinue(); await settle();
      check(userRows().length === 1 && document.querySelectorAll(".message-user").length === 2, "a later typed continue was hidden");
      qa.stage("interrupted"); await settle();
      qa.reasoning(); await settle();
      check(!recovery(), "resuming by another route left the old Continue action available");
      qa.repeatFailure(); await settle();
      check(document.querySelectorAll(".timeline-error-recovery").length === 1, "only the new interruption should offer Continue");
      qa.stage("eyes-working"); await settle(); qa.status("idle"); await settle();
      check(running() === 1, "idle parent settled a running Eyes inspection");
      const animation = document.querySelector(".reasoning-running").getAnimations({ subtree: true })[0];
      check(animation?.playState === "running", "Eyes glimmer has no active animation");
      qa.toolEnd(); await settle(); check(!running(), "completed Eyes shimmered while idle");
      qa.stage("ordinary"); await settle(); check(!running(), "ordinary idle tool acquired an Eyes override");
      qa.stage("eyes-working"); await settle(); qa.toolEnd("failed"); qa.status("idle"); await settle();
      check(!running() && document.querySelector(".timeline-error-notice").textContent.includes("API key"), "Eyes failure did not settle with its notice");
      qa.stageStop(); await settle();
      const stopButton = () => document.querySelector('[aria-label="Stop task"]');
      check(stopButton() && running() === 1, "the running task must expose Stop and live reasoning");
      stopButton().click(); await settle();
      check(qa.calls.length === 1 && qa.pendingInterrupt, "Stop must dispatch one interrupt request");
      check(qa.snapshot.sessions[0].state === "working" && !qa.stop && running() === 1, "pending Stop falsely presented the task as stopped");
      qa.pendingInterrupt("No active provider turn"); await settle();
      check(qa.notifications.includes("No active provider turn"), "a rejected interrupt must remain visible");
      check(qa.snapshot.sessions[0].state === "working" && !qa.stop && running() === 1 && stopButton(), "a rejected Stop falsely settled the task");
      stopButton().click(); await settle();
      qa.confirmStop(); qa.pendingInterrupt(); await settle();
      check(qa.calls.length === 2 && qa.snapshot.sessions[0].state === "idle" && !running(), "confirmed interruption did not settle the task");
      check(!stopButton() && recovery(), "confirmed interruption must offer Continue rather than Stop");
      return { ok: true };
    };
    await writeFile(join(directory, "main.cjs"), `
      const {app,BrowserWindow}=require('electron');
      app.commandLine.appendSwitch('disable-gpu');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{
        const w=new BrowserWindow({show:false,width:1100,height:820,webPreferences:{backgroundThrottling:false,offscreen:!!process.env.TETHOQ_RECOVERY_QA_ARTIFACTS}});
        await w.loadFile(require('node:path').join(__dirname,'index.html'));
        if (process.env.TETHOQ_RECOVERY_QA_ARTIFACTS) {
          const fs=require('node:fs/promises'), path=require('node:path');
          await fs.mkdir(process.env.TETHOQ_RECOVERY_QA_ARTIFACTS,{recursive:true});
          const rects=await w.webContents.executeJavaScript(
            '(async()=>{for(let i=0;!document.querySelector(".timeline-error-recovery")&&i<100;i++)await new Promise(r=>setTimeout(r,20)); await new Promise(r=>setTimeout(r,100)); const notice=document.querySelector(".timeline-error-notice").getBoundingClientRect();return {crop:{x:Math.max(0,Math.floor(notice.x)-8),y:Math.max(0,Math.floor(notice.y)-8),width:Math.ceil(notice.width)+16,height:Math.ceil(notice.height)+16}}})()');
          await fs.writeFile(path.join(process.env.TETHOQ_RECOVERY_QA_ARTIFACTS,'continue-rest.png'),(await w.webContents.capturePage(rects.crop)).toPNG());
          const styleScript='(()=>{const style=getComputedStyle(document.querySelector(".timeline-error-recovery"));return {color:style.color,background:style.backgroundColor,border:style.borderColor,padding:style.padding}})()';
          const restStyle=await w.webContents.executeJavaScript(styleScript);
          w.webContents.debugger.attach('1.3');
          await w.webContents.debugger.sendCommand('DOM.enable');
          await w.webContents.debugger.sendCommand('CSS.enable');
          const {root}=await w.webContents.debugger.sendCommand('DOM.getDocument');
          const {nodeId}=await w.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.timeline-error-recovery'});
          await w.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['hover']});
          await new Promise(r=>setTimeout(r,180));
          const hoverStyle=await w.webContents.executeJavaScript(styleScript);
          if(restStyle.color===hoverStyle.color||restStyle.background===hoverStyle.background)throw new Error('Continue hover did not brighten text and reveal its background');
          await fs.writeFile(path.join(process.env.TETHOQ_RECOVERY_QA_ARTIFACTS,'continue-styles.json'),JSON.stringify({rest:restStyle,hover:hoverStyle},null,2));
          await fs.writeFile(path.join(process.env.TETHOQ_RECOVERY_QA_ARTIFACTS,'continue-hover.png'),(await w.webContents.capturePage(rects.crop)).toPNG());
          await w.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});
          w.webContents.debugger.detach();
        }
        const result=await w.webContents.executeJavaScript(${JSON.stringify(`(${checks.toString()})().catch(error => ({ok:false,error:error.stack}))`)},true);
        console.log('RECOVERY_QA='+JSON.stringify(result)); w.destroy(); app.quit();
      }).catch(error=>{console.error(error);app.exit(1);});
    `);
    const result = await new Promise((resolveResult, reject) => {
      const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronPath, [join(directory, "main.cjs")], { cwd: appRoot, env, windowsHide: true });
      let output = ""; let errors = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Recovery QA timed out: ${errors}`)); }, 30_000);
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", code => {
        clearTimeout(timeout);
        const marker = output.split(/\r?\n/u).find(line => line.startsWith("RECOVERY_QA="));
        if (code !== 0 || !marker) reject(new Error(`Recovery QA exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(marker.slice("RECOVERY_QA=".length)));
      });
    });
    assert.deepEqual(result, { ok: true }, result.error);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
