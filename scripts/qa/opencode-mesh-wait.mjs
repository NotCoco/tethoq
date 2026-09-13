// Run after npm run build. Uses real OpenCode with an isolated home and a local model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeshToolGateway } from '../../dist/apps/agent_bridge/src/mesh_tools.js';
import { installOpenCodeMeshTools } from '../../dist/apps/agent_bridge/src/opencode_tools.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const root = join(workspace, 'local-artifacts', 'mesh-wait-qa', String(Date.now()));
await mkdir(root, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 30_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await predicate()) return; await wait(50); }
  throw new Error('Timed out: ' + label);
}
const runtimePath = join(root, 'runtime.json');
const sourcePath = join(root, 'tool-source.txt');
const targetPath = join(root, 'config', 'opencode', 'tools', 'uar_mesh.ts');
const plugin = process.env.OPENCODE_TEST_PLUGIN ?? join(homedir(), '.config/opencode/node_modules/@opencode-ai/plugin/dist/index.js');
const source = (await readFile(join(workspace, 'apps/agent_bridge/assets/opencode/uar_mesh.txt'), 'utf8'))
  .replace('"@opencode-ai/plugin"', JSON.stringify(pathToFileURL(plugin).href))
  .replace('const configuredRuntimePath = process.env.UAR_MESH_RUNTIME', `const configuredRuntimePath = ${JSON.stringify(runtimePath)}`)
  .replace('const legacyRuntimePath = join(homedir(), ".tethoq", "mesh-tool-runtime.json")', `const legacyRuntimePath = ${JSON.stringify(join(root, 'legacy.json'))}`)
  .replace('const runtimeDirectory = join(homedir(), ".tethoq", "mesh-runtimes")', `const runtimeDirectory = ${JSON.stringify(join(root, 'runtimes'))}`);
await writeFile(sourcePath, source.replace('const runtimeActiveTimeoutMs = 30_000', 'const runtimeActiveTimeoutMs = 750'));
await installOpenCodeMeshTools({ sourcePath, targetPath });
let calls = 0;
const gateway = new MeshToolGateway('mesh-wait-qa', async (_parent, tool, input) => {
  assert.equal(tool, 'mesh_wait');
  assert.equal(input.timeout_seconds, 300);
  calls++;
  console.log('Gateway call', calls);
  if (calls === 2) {
    await wait(700); // Allow the client to receive the acceptance heartbeat first.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    return { timedOut: true, children: [{ sessionId: 'qa-child', state: 'working' }] };
  }
  if (calls === 3) throw Object.assign(new Error('The selected child no longer exists'), { code: 'CHILD_NOT_FOUND' });
  return { timedOut: false, children: [{ sessionId: 'qa-child', state: 'idle' }] };
}, { runtimePath });
await gateway.listen();

const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(!input.tools?.some(tool => tool.function?.name === 'uar_mesh_invoke'), 'The transport entry point is not a model tool');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'mesh-qa',
    object: 'chat.completion.chunk', model: 'qa', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (input.tools?.some(tool => tool.function?.name === 'uar_mesh_wait') && !input.messages.some(message => message.role === 'tool')) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'mesh-wait-call', type: 'function',
      function: { name: 'uar_mesh_wait', arguments: JSON.stringify({ child_session_ids: ['qa-child'], timeout_seconds: 300 }) } }] });
    emit({}, 'tool_calls');
  } else { emit({ role: 'assistant', content: 'Mesh QA finished.' }); emit({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const config = { enabled_providers: ['offline'], model: 'offline/qa', small_model: 'offline/qa',
  provider: { offline: { npm: '@ai-sdk/openai-compatible', name: 'Offline QA',
    options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'not-a-real-key' },
    models: { qa: { name: 'QA', limit: { context: 1_000_000, output: 1000 } } } } },
  permission: 'allow', share: 'disabled', autoupdate: false };
const server = spawn(process.env.OPENCODE_TEST_BINARY ?? 'C:/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode.exe',
  ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_SERVER_PASSWORD: '' },
  });
let logs = ''; let spawnError; let url;
server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
server.on('error', error => { spawnError = error; });
const sessions = [];
async function native(path, body) {
  const response = await fetch(url + path, { ...(body === undefined ? {} : { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, `${path}: ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : undefined;
}
async function turn(title) {
  const session = await native('/session', { title }); sessions.push(session.id);
  const start = performance.now();
  await native(`/session/${session.id}/prompt_async`, { model: { providerID: 'offline', modelID: 'qa' },
    parts: [{ type: 'text', text: 'Call uar_mesh_wait once, then finish.' }] });
  let part;
  await until(async () => {
    const messages = await native(`/session/${session.id}/message`);
    part = messages.flatMap(message => message.parts).find(part => part.tool === 'uar_mesh_wait');
    return part && ['completed', 'error'].includes(part.state.status)
      && messages.some(message => message.info.finish === 'stop');
  }, title, 45_000);
  return { status: part.state.status, error: part.state.error,
    output: part.state.output ? JSON.parse(part.state.output) : undefined, elapsedMs: performance.now() - start };
}
try {
  await until(() => { if (spawnError) throw spawnError; return /http:\/\/127\.0\.0\.1:\d+/.test(logs); }, 'isolated OpenCode start', 45_000);
  url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const before = await turn('Before helper update');
  assert.equal(before.status, 'completed');
  await writeFile(sourcePath, source);
  await installOpenCodeMeshTools({ sourcePath, targetPath });
  const after = await turn('Waiting through a busy bridge after helper update');
  assert.equal(after.status, 'completed');
  assert.equal(after.output.timedOut, true);
  assert.equal(after.output.children[0].state, 'working');
  assert.ok(after.elapsedMs >= 2500);
  const failure = await turn('A genuine missing-child error');
  assert.equal(failure.status, 'error');
  assert.match(failure.error, /selected child no longer exists/);
  assert.equal(calls, 3, 'A reconnect must not duplicate tool execution');
  const report = { ok: true, sameOpenCodeProcess: server.pid, paidModelRequests: 0, before, after, failure, gatewayCalls: calls };
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (url) await Promise.allSettled(sessions.map(id => native(`/session/${id}/abort`, {})));
  server.kill(); await gateway.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(join(root, 'server.log'), logs);
}
