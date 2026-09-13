// Token-free integration QA: real OpenCode, Bridge, SQLite and tool processes.
// Run after npm run build. Uses an isolated OpenCode home and localhost model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBridge } from '../../dist/apps/agent_bridge/src/bridge.js';
import { OpenCodeAdapter } from '../../dist/packages/provider_opencode/src/opencode_adapter.js';
import { createHostIdentity } from '../../dist/packages/protocol/src/index.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(workspace, 'local-artifacts', 'opencode-stop-qa', String(Date.now()));
await mkdir(directory, { recursive: true });
const toolScript = join(directory, 'running-tool.cjs');
const heartbeat = join(directory, 'tool-heartbeat.txt');
await writeFile(toolScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(directory, 'tool-pid.txt'))},String(process.pid));setInterval(()=>{fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));process.stdout.write('tool still working\\n');},60);`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await predicate()) return; await wait(30); }
  throw new Error('Timed out: ' + label);
}
const streams = new Map();
const requests = [];
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push({ at: Date.now(), model: request.model, tools: request.tools?.map(tool => tool.function?.name) ?? [] });
  const text = JSON.stringify(request.messages ?? []);
  const marker = ['STOP_QA_RESUMED', 'STOP_QA_TOOL', 'STOP_QA_CHILD', 'STOP_QA_GRANDCHILD'].find(marker => text.includes(marker));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fake-' + requests.length,
    object: 'chat.completion.chunk', model: 'qa', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (marker === 'STOP_QA_TOOL' && request.tools?.some(tool => tool.function?.name === 'bash') && !request.messages.some(message => message.role === 'tool')) {
    const command = (process.platform === 'win32' ? '& ' : '') + JSON.stringify(process.execPath.replaceAll('\\', '/')) + ' ' + JSON.stringify(toolScript.replaceAll('\\', '/'));
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'long-running-tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Run the cancellable offline QA tool', timeout: 120000 }) } }] });
    chunk({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  } else if (marker && marker !== 'STOP_QA_RESUMED' && request.tools?.length) {
    streams.set(marker, { startedAt: performance.now(), closedAt: null });
    chunk({ role: 'assistant', content: 'Offline model is working. ' });
    const timer = setInterval(() => chunk({ content: 'Still working. ' }), 40);
    res.on('close', () => { clearInterval(timer); streams.get(marker).closedAt = performance.now(); });
  } else {
    chunk({ role: 'assistant', content: marker === 'STOP_QA_RESUMED' ? 'Resumed successfully.' : 'Offline stop QA' });
    chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const cfg = { enabled_providers: ['offline'], model: 'offline/qa', small_model: 'offline/qa',
  provider: { offline: { npm: '@ai-sdk/openai-compatible', name: 'Offline QA',
    options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'not-a-real-key' },
    models: { qa: { name: 'QA', limit: { context: 1000000, output: 1000 } } } } },
  permission: 'allow', share: 'disabled', autoupdate: false };
const binary = process.env.OPENCODE_TEST_BINARY ?? 'C:/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode.exe';
const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'), OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
    OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_SERVER_PASSWORD: '' },
});
let logs = ''; let spawnError;
server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
server.on('error', error => { spawnError = error; });
let bridge; let adapter; let nativeUrl; const nativeSessions = []; const events = [];
let cancelledAbortResponses = 0;
const native = async (path, body) => {
  const response = await fetch(nativeUrl + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${path}: ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : undefined;
};
try {
  await until(() => { if (spawnError) throw spawnError; return /http:\/\/127\.0\.0\.1:\d+/.test(logs); }, 'isolated OpenCode start', 45_000);
  nativeUrl = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  adapter = new OpenCodeAdapter({ hostId: 'stop-native-qa', baseUrl: nativeUrl, directory,
    fetch: async (input, init) => {
      const abortRequest = new URL(String(input)).pathname.endsWith('/abort');
      try {
      const response = await fetch(input, init);
      if (!abortRequest) return response;
      // The real server has handled the abort. Reproduce a slow response drain
      // while its real SQLite writes, child cancellation and SSE keep running.
      return await new Promise((resolveResponse, reject) => {
        const finish = () => { clearTimeout(timer); init.signal.removeEventListener('abort', cancelled); };
        const cancelled = () => { finish(); void response.body?.cancel().catch(() => undefined); reject(new Error('delayed abort response cancelled')); };
        const timer = setTimeout(() => { finish(); resolveResponse(response); }, 8000);
        if (init.signal.aborted) cancelled(); else init.signal.addEventListener('abort', cancelled, { once: true });
      });
      } catch (error) {
        if (abortRequest && init.signal.aborted) cancelledAbortResponses++;
        throw error;
      }
    },
    localActivity: { databasePath: join(directory, 'data/opencode/opencode.db') }, activityPollIntervalMs: 100 });
  await adapter.subscribe(null, event => { events.push(event); });
  bridge = new AgentBridge({ version: 1, hostId: 'stop-native-qa', identity: createHostIdentity(), displayName: 'Offline stop QA', enabledProviders: ['opencode'] }, [adapter]);
  await bridge.start();
  const parent = await bridge.createSession('opencode', { workingDirectory: directory, title: 'STOP_QA_TOOL', modelId: 'offline/qa' });
  nativeSessions.push(parent.providerSessionId);
  const child = await native('/session', { parentID: parent.providerSessionId, title: 'STOP_QA_CHILD' });
  nativeSessions.push(child.id);
  const grandchild = await native('/session', { parentID: child.id, title: 'STOP_QA_GRANDCHILD' });
  nativeSessions.push(grandchild.id);
  await bridge.sendMessage(parent.id, { requestId: 'root', content: 'STOP_QA_TOOL', modelId: 'offline/qa' });
  for (const [id, marker] of [[child.id, 'STOP_QA_CHILD'], [grandchild.id, 'STOP_QA_GRANDCHILD']]) {
    await native(`/session/${id}/prompt_async`, { model: { providerID: 'offline', modelID: 'qa' }, parts: [{ type: 'text', text: marker }] });
  }
  await until(async () => streams.size === 2 && await stat(heartbeat).then(() => true, () => false), 'real tool and two native child streams', 45_000);
  const knownBeforeStop = bridge.sessions().map(session => session.providerSessionId);
  const toolPid = Number(await readFile(join(directory, 'tool-pid.txt'), 'utf8'));
  assert.ok(Number.isSafeInteger(toolPid) && toolPid > 0);
  const toolRunning = () => { try { process.kill(toolPid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  assert.ok(toolRunning(), 'the fixture must start an actual tool process before Stop');
  const stopStarted = performance.now();
  await bridge.interrupt(parent.id);
  const acknowledgementMs = performance.now() - stopStarted;
  await until(() => [...streams.values()].every(stream => stream.closedAt !== null), 'all native child streams stopped', 3000);
  const allChildrenStoppedMs = Math.max(...[...streams.values()].map(stream => stream.closedAt - stopStarted));
  await until(() => !toolRunning(), 'native tool process exited', Math.max(1, 3000 - (performance.now() - stopStarted)));
  const toolStoppedMs = performance.now() - stopStarted;
  const heartbeatAfter = await readFile(heartbeat, 'utf8');
  await wait(350);
  assert.equal(await readFile(heartbeat, 'utf8'), heartbeatAfter, 'the native tool process kept running after Stop');
  assert.ok(acknowledgementMs < 3000, `Stop acknowledgement took ${acknowledgementMs.toFixed(0)} ms`);
  assert.ok(allChildrenStoppedMs < 3000, `Child cancellation took ${allChildrenStoppedMs.toFixed(0)} ms`);
  const stoppedHistory = await adapter.getMessages(parent.providerSessionId);
  const stoppedEvents = events.filter(event => event.providerSessionId === parent.providerSessionId).map(event => ({ ...event, sessionId: parent.id }));
  await writeFile(join(directory, 'stopped-transcript.json'), JSON.stringify({ sessionId: parent.id, messages: stoppedHistory, events: stoppedEvents }, null, 2));
  assert.ok(cancelledAbortResponses > 0, 'the real SSE cleanup must retire stalled HTTP responses');
  const requestCountBeforeResume = requests.length;
  await bridge.sendMessage(parent.id, { requestId: 'resume', content: 'STOP_QA_RESUMED', modelId: 'offline/qa' });
  await until(async () => !adapter.hasActiveTurn(parent.providerSessionId)
    && (await adapter.getMessages(parent.providerSessionId)).some(message => message.role === 'assistant'
      && message.parts.some(part => part.type === 'text' && part.text.includes('Resumed successfully.'))), 'a healthy turn after interruption');
  assert.equal(requests.length, requestCountBeforeResume + 1, 'resume must send exactly one model request');
  const report = { ok: true, realOpenCode: true, fakeModel: true, paidModelRequests: 0, acknowledgementMs, allChildrenStoppedMs, toolStoppedMs,
    nativeSessions: nativeSessions.length, toolStopped: true, modelRequests: requests.length,
    knownSessionsBeforeStop: knownBeforeStop.length, cancelledAbortResponses, resumedSuccessfully: true,
    interruptedEvents: events.filter(event => event.type === 'agent.interrupted').length,
    errorEvents: events.filter(event => event.type === 'agent.error').map(event => event.payload),
    storedErrors: stoppedHistory.flatMap(message => message.parts.filter(part => part.type === 'error')) };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: error.message, requests, events: events.map(({ type, providerSessionId, payload }) => ({ type, providerSessionId, payload })) }, null, 2));
  throw error;
} finally {
  // Cancellation and process cleanup are scoped to this isolated fixture only.
  if (nativeUrl) await Promise.allSettled(nativeSessions.map(id => native(`/session/${id}/abort`, {})));
  await bridge?.dispose(); if (!bridge) await adapter?.dispose();
  server.kill(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(join(directory, 'server.log'), logs);
}
