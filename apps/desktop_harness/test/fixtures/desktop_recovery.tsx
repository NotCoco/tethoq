import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';

const noop = () => {};
const qa: any = window.qa = { calls: [], notifications: [], pending: null, scenario: 1 };
window.tethoqDesktop = {
  request: async (type, payload) => {
    if (type === 'session.continue') {
      qa.calls.push({type, payload});
      return new Promise(resolve => { qa.pending = (error?: string) => resolve(error
        ? {ok:false, error:{message:error,code:'qa_rejected'},payload:{}}
        : {ok:true,payload:{}}); });
    }
    if (type === 'session.interrupt') {
      qa.calls.push({type,payload});
      if (qa.deferInterrupt) return new Promise(resolve => { qa.pendingInterrupt = (error?: string) => resolve(error
        ? {ok:false,error:{message:error,code:'qa_rejected'},payload:{}}
        : {ok:true,payload:{}}); });
    }
    return {ok:true,payload:{messages:[],targets:[],models:[],vision:{sessionId:'qa-session',primaryModelSupportsImageInput:false}}};
  }, selectImages: async () => [], selectFiles: async () => [],
};
const [{Workspace}, {eventToTimeline}, {mergeTimeline}, {captureSessionWorkingBoundary}] = await Promise.all([
  import('../../src/renderer/src/App.tsx'),
  import('../../src/renderer/src/bridge.ts'),
  import('../../src/renderer/src/timeline_merge.ts'),
  import('../../src/renderer/src/composer_helpers.ts'),
]);
const stamp = () => new Date().toISOString();
const user = {id:'user-1',kind:'user',body:'Please inspect this image.',timestamp:stamp(),state:'completed'};
const thought = {id:'reason-1',kind:'reasoning',body:'I will inspect the attached image before continuing.',timestamp:stamp(),state:'completed'};
const interrupted = {id:'interrupted-1',kind:'error',body:'Task interrupted',timestamp:stamp(),state:'completed'};
const eyesEvent = (type='tool.started', status='running', tool='ask_eyes') => eventToTimeline({
  eventId: crypto.randomUUID(), sessionId:'qa-session', providerId:'opencode',type,occurredAt:stamp(),
  payload:{name:tool==='ask_eyes'?'Inspect attached images':'Read file',tool,callId:'eyes-qa-1',status,output:status==='failed'?'API key is invalid':'Inspecting attached images'},
});
const provider = {id:'opencode',name:'OpenCode',state:'online',detected:true,supportsAttachments:true,capabilities:['Send Message','Session History','Interrupt']};
const session = {id:'qa-session',providerId:'opencode',title:'Eyes and task recovery',state:'idle',project:'qa',workingDirectory:'',preview:'',updatedAt:stamp(),model:'deepseek/deepseek-v4-pro',effort:'High'};
const original = {providers:[provider],models:{opencode:[{id:session.model,name:'DeepSeek V4 Pro',efforts:['high'],isDefault:true}]},sessions:[session],timelines:{[session.id]:[user,thought,interrupted]},approvals:[],inputRequests:[],goals:{},goalClearRevisions:{}};
const file = {kind:'file',path:'C:/qa/draft.txt',name:'draft.txt',mimeType:'text/plain',dataBase64:'a2VlcA==',byteLength:4};
function Fixture() {
  const [snapshot,setSnapshot] = useState(original);
  const [stop,setStop] = useState(true);
  const [draft,setDraft] = useState('Keep this unsent draft.');
  const [attachments,setAttachments] = useState([file]);
  const [boundary,setBoundary] = useState(undefined);
  const [display,setDisplay] = useState('compact');
  const [notifications,setNotifications] = useState([]);
  const [restoreRevision,setRestoreRevision] = useState(0);
  qa.snapshot = snapshot; qa.draft = draft; qa.attachments = attachments; qa.stop = stop;
  qa.stage = (scenario) => {
    qa.calls = []; qa.notifications = []; setNotifications([]); setBoundary(undefined);
    setStop(scenario==='interrupted');
    const timeline = scenario==='interrupted' ? [user,thought,{...interrupted,id:'interrupted-'+(++qa.scenario),timestamp:stamp()}] : [user,thought,eyesEvent('tool.started','running',scenario==='ordinary'?'read_file':'ask_eyes')];
    setSnapshot({...original,sessions:[{...session,state:scenario==='eyes-working'?'working':'idle'}],timelines:{[session.id]:timeline}});
  };
  qa.status = state => setSnapshot(s => ({...s,sessions:s.sessions.map(v=>({...v,state}))}));
  qa.toolEnd = (status='completed') => setSnapshot(s => ({...s,timelines:{[session.id]:mergeTimeline(s.timelines[session.id], eyesEvent('tool.completed',status))}}));
  qa.final = () => setSnapshot(s=>({...s,sessions:[{...s.sessions[0],state:'completed'}],timelines:{[session.id]:[...s.timelines[session.id],{id:'answer',kind:'assistant',phase:'final_answer',body:'The image shows a two-way conversation.',state:'completed',timestamp:stamp()}]}}));
  qa.echo = () => setSnapshot(s => ({...s,timelines:{[session.id]:[...s.timelines[session.id],{id:'provider-continue',kind:'user',body:'',state:'completed',timestamp:stamp()}]}}));
  qa.typedContinue = () => setSnapshot(s => ({...s,timelines:{[session.id]:[...s.timelines[session.id],{id:'typed-continue',kind:'user',body:'continue',state:'completed',timestamp:stamp()}]}}));
  qa.reasoning = () => setSnapshot(s => ({...s,timelines:{[session.id]:[...s.timelines[session.id],{...thought,id:'resumed-reasoning',timestamp:stamp()}]}}));
  qa.repeatFailure = () => setSnapshot(s => ({...s,timelines:{[session.id]:[...s.timelines[session.id],{...interrupted,id:'later-interruption',timestamp:stamp()}]}}));
  qa.display = setDisplay;
  qa.stageStop = () => {
    qa.calls = []; qa.notifications = []; qa.deferInterrupt = true;
    setNotifications([]); setStop(false); setBoundary(undefined); setDraft(''); setAttachments([]);
    setRestoreRevision(value=>value+1);
    setSnapshot({...original,sessions:[{...session,state:'working'}],timelines:{[session.id]:[user,{...thought,state:'running'}]}});
  };
  qa.confirmStop = () => setSnapshot(s=>({...s,sessions:[{...s.sessions[0],state:'idle',interruptedAt:stamp()}],
    timelines:{[session.id]:[user,thought,{...interrupted,id:'confirmed-stop-'+(++qa.scenario),state:'failed',timestamp:stamp()}]}}));
  return <><Workspace snapshot={snapshot} session={snapshot.sessions[0]} workingBoundary={boundary}
    stopPresentationActive={stop} onStopPresentation={(_id,value)=>setStop(value)}
    onPrepareTurnResume={() => { const b=captureSessionWorkingBoundary(qa.snapshot.timelines[session.id]); return ()=>setBoundary(b); }}
    onBack={noop} onBrowser={noop} onLinkOpen={noop} onManageWorkflow={noop}
    onDraftSelectionChange={noop} onCreateDraftSend={noop} onMaterializeDraft={noop} pendingComposerAction={null} onPendingComposerActionConsumed={noop}
    onCreateDraftSchedule={noop} draftScheduleAttempt={null} onRetainDraftScheduleAttempt={x=>x} onDraftDirectory={noop}
    initialDraft={draft} onDraftChange={setDraft} initialAttachments={attachments} onAttachmentsChange={setAttachments}
    initialWorkflowAttachments={[]} onWorkflowAttachmentsChange={noop} initialAnnotations={[]} onAnnotationsChange={noop}
    initialMode="queue" onModeChange={noop} initialMeshTargets={[]} onMeshTargetsChange={noop} onDelegationDraftChange={noop}
    draftRestoreRevision={restoreRevision} onRestoreFailedSubmission={x=>x} onDerivedSession={noop} onRetryQueuedNewTaskDelivery={noop}
    onOpenChild={noop} onOpenParent={noop} notify={(text)=>{qa.notifications.push(text);setNotifications(a=>[...a,text]);}}
    updateSnapshot={setSnapshot} onAttentionMutation={noop} onHydrateProviderModels={async()=>{}}
    timelineWindow={{revealStart:0,loadingOlder:false}} reasoningDisplay={display} agentDefaults={{}} ears={{enabled:false,mode:'transcribe'}} onEarsChange={async()=>{}}
    experimental={false} foreignSubagentsEnabled={false} sessionForeignSubagents={false} onSessionForeignSubagents={noop}
    onInstantSession={noop} onCreateSideChat={async()=>{}} onContextHandoff={async()=>{}} queueRevision={0} queueingEnabled={true} onQueueingEnabledChange={noop}
  />{notifications.map((n,i)=><div key={i} role="status" style={{position:'fixed',top:70,right:20,background:'#35272a',padding:12}}>{n}</div>)}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
