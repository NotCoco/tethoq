import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");

test("mounted questions and permission settings preserve native choices and failed responses", { timeout: 60_000 }, async () => {
  const directory = join(tmpdir(), `tethoq-questions-${process.pid}-${Date.now()}`);
  const artifacts = resolve(appRoot, "../../local-artifacts/qa/2026-09-06-questions-permissions");
  await mkdir(directory, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  try {
    await build({
      stdin: { resolveDir: appRoot, sourcefile: "question-qa.tsx", loader: "tsx", contents: String.raw`
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { QuestionCard } from "./src/renderer/src/QuestionCard";
        import { PermissionSettings } from "./src/renderer/src/PermissionSettings";
        import { mapInput } from "./src/renderer/src/bridge";
        import "./src/renderer/src/styles.css";
        import "./src/renderer/src/composer.css";
        const root = createRoot(document.getElementById("root"));
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 35));
        const render = async node => { flushSync(() => root.render(node)); await settle(); };
        const question = mapInput({requestId:"request-one",sessionId:"session",title:"Question",request:{questions:[
          {id:"storage",header:"Storage",question:"Where should the app store its data?",custom:false,options:[{label:"SQLite",description:"Keep the data on this device."},{label:"Postgres",description:"Share data across devices."}]},
          {id:"features",header:"Features",question:"Which features should be included?",multiple:true,options:[{label:"Search",description:"Find saved items quickly."},{label:"Export",description:"Download a copy of your data."}]}
        ]}});
        let mode="ask", fail=false;
        const calls=[];
        const settings=()=>({controls:[{id:"tool_permissions",label:"Tool permissions",value:mode,options:[{value:"ask",label:"Ask"},{value:"allow",label:"Allow"},{value:"deny",label:"Deny"}]}]});
        const request=async(type,payload)=>{calls.push({type,payload});if(type.endsWith(".set")){if(fail)throw Error("Harness refused this change");mode=payload.value;}return settings();};
        const setSelect = async(value) => {const el=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("change",{bubbles:true}));await settle();};
        const setText=async(el,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));await settle();};
        window.runQa=async()=>{
          const answers=[];let reject=true;
          await render(<QuestionCard request={question} onSubmit={async value=>{if(reject)throw Error("Try again");answers.push(value);}}/>);
          check(document.querySelectorAll('fieldset').length===2,"Only the first question was shown");
          check(document.querySelector('summary').textContent==='ActivityQuestion',"Question activity heading changed");
          check(document.querySelector('button[type=submit]').disabled,"Unanswered questions were submittable");
          document.querySelector('input[value=SQLite]').click();await settle();
          check(document.querySelector('button[type=submit]').disabled,"A partial answer was submittable");
          document.querySelector('input[value=Search]').click();await settle();
          await setText(document.querySelector('textarea'),"Offline cache");
          document.querySelector('button[type=submit]').click();await settle();
          check(document.querySelector('[role=alert]')?.textContent==='Try again',"Failed response was hidden");
          check(document.querySelector('textarea').value==='Offline cache',"Failed response erased the answer");
          reject=false;document.querySelector('button[type=submit]').click();await settle();
          check(JSON.stringify(answers[0])===JSON.stringify({storage:["SQLite"],features:["Search","Offline cache"]}),"Native question keys or multiple answers were lost");
          let closed=0;
          await render(<PermissionSettings sessionId="session" request={request} onClose={()=>{closed++;}}/>);
          check(calls[0]?.type==='session.permissions.get' && calls[0].payload.sessionId==='session',"Permission read lost task scope");
          check(!document.body.textContent.includes('Loading this task'),"Loaded permissions still claim to be loading");
          await setSelect("deny");check(mode==='deny'&&document.querySelector('select').value==='deny',"Confirmed setting was not displayed");
          fail=true;await setSelect("allow");
          check(mode==='deny'&&document.querySelector('select').value==='deny',"Failed permission change was displayed as successful");
          check(document.querySelector('[role=alert]')?.textContent.includes('Harness refused'),"Permission error was hidden");
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
          check(closed===1,"Escape did not close the permissions panel");
          await render(<PermissionSettings key="unsupported" sessionId="other" request={async()=>({controls:[],note:"This harness does not expose permission settings."})} onClose={()=>{}}/>);
          check(!document.querySelector('select')&&document.body.textContent.includes('does not expose'),"Unsupported harness showed invented options");
          const formRequest=mapInput({requestId:"form",sessionId:"session",title:"Project details",prompt:"Choose a name and retry count.",request:{kind:"elicitation",mode:"form",requestedSchema:{type:"object",properties:{name:{type:"string",title:"Project name"},retries:{type:"integer",minimum:0,maximum:5}},required:["name","retries"]}}});
          const forms=[];
          await render(<QuestionCard request={formRequest} onSubmit={async value=>{forms.push(value);}}/>);
          for(const [index,value]of [[0,"Atlas"],[1,"3"]]){const el=document.querySelectorAll('input')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await settle();}
          document.querySelector('button[type=submit]').click();await settle();
          check(forms[0]?.action==='accept'&&forms[0].content.retries===3&&forms[0].content.name==='Atlas',"Form did not preserve typed native values");
          await render(<QuestionCard key="pi" request={mapInput({requestId:"pi",sessionId:"session",title:"Choose format",request:{questionId:"answer",options:["JSON","CSV"]}})} onSubmit={async()=>{}}/>);
          check(document.querySelectorAll('input[type=radio]').length===2,"Legacy harness options disappeared");
          return {ok:true};
        };
        window.paintQa=async()=>{mode="ask";fail=false;await render(<main style={{maxWidth:760,margin:"35px auto",padding:"0 22px"}}><h2 style={{fontSize:16,fontWeight:500}}>Build the project tracker</h2><QuestionCard request={question} onSubmit={async()=>{}}/><PermissionSettings sessionId="session" request={request} onClose={()=>{}}/></main>);};
      ` },
      bundle: true, outfile: join(directory, "renderer.js"), platform: "browser", format: "esm", loader: { ".css": "css" },
    });
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "main.cjs"), String.raw`
      const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-gpu');
      app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1100,height:1020,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}});
        await window.loadFile(path.join(__dirname,'index.html'));
        const result=await window.webContents.executeJavaScript('window.runQa()');
        await window.webContents.executeJavaScript('window.paintQa()');await new Promise(r=>setTimeout(r,150));await window.webContents.capturePage();await new Promise(r=>setTimeout(r,120));
        fs.writeFileSync(process.argv[2],(await window.webContents.capturePage()).toPNG());
        process.stdout.write('QUESTION_QA='+JSON.stringify(result)+'\n');window.destroy();app.quit();
      }).catch(error=>{console.error(error);app.exit(1);});
    `);
    const result = await new Promise((resolveRun, reject) => {
      const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [join(directory, "main.cjs"), join(artifacts, "questions-permissions.png")], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Question QA timed out: ${output}`)); }, 45_000);
      child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject); child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolveRun(output) : reject(new Error(output)); });
    });
    assert.match(result, /QUESTION_QA=\{"ok":true\}/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
