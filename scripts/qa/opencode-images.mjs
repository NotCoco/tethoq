// Real OpenCode and Bridge with an isolated home and a localhost model. No paid requests.
// Run after npm run build; override OPENCODE_TEST_BINARY if needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentBridge } from '../../dist/apps/agent_bridge/src/bridge.js';
import { OpenCodeAdapter } from '../../dist/packages/provider_opencode/src/opencode_adapter.js';
import { createHostIdentity } from '../../dist/packages/protocol/src/index.js';
import { installOpenCodeImagePolicy } from '../../dist/apps/agent_bridge/src/opencode_tools.js';
import pngjs from 'pngjs';

const directory = fileURLToPath(new URL(`../../local-artifacts/opencode-image-qa/${Date.now()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 45_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await predicate()) return; await wait(40); }
  throw new Error('Timed out: ' + label);
}
const requests = [];
const events = [];
const toolImagePath = join(directory, 'tool-image.png');
let toolImageCallsMade = false;
let textToolCallsMade = false;
let summaries = 0;
function imageCount(value) {
  if (Array.isArray(value)) return value.reduce((count, item) => count + imageCount(item), 0);
  if (!value || typeof value !== 'object') return 0;
  if (value.type === 'image_url' || value.type === 'input_image') return 1;
  return Object.values(value).reduce((count, item) => count + imageCount(item), 0);
}
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const count = imageCount(body.messages);
  requests.push({ count, body });
  console.log(`Model request ${requests.length}: ${count} images, ${body.tools?.length ?? 0} tools`);
  if (count > 30) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Too many images in request: ${count} > 30` } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: `offline-${requests.length}`,
    object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (!toolImageCallsMade && body.tools?.some(tool => tool.function?.name === 'read') && JSON.stringify(body.messages).includes('TOOL_IMAGE_QA')) {
    toolImageCallsMade = true;
    chunk({ role: 'assistant', tool_calls: Array.from({ length: 4 }, (_, index) => ({ index, id: `image-read-${index}`, type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ filePath: toolImagePath }) } })) });
    chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
  }
  if (toolImageCallsMade && !textToolCallsMade && JSON.stringify(body.messages).includes('TOOL_IMAGE_QA')) {
    textToolCallsMade = true;
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'text-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(directory, 'note.txt') }) } }] });
    chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
  }
  chunk({ role: 'assistant', content: body.tools?.length ? 'IMAGE_QA_SUCCESS: reviewed the available images.' : 'Image review progress: prior images reviewed; continue the latest user request. Original images remain in the saved conversation.' });
  chunk({}, 'stop'); res.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const stateRoot = join(directory, 'image-policy-state');
const cacheRoot = join(directory, 'image-cache');
await installOpenCodeImagePolicy({ userHome: directory });
const pluginPath = join(directory, '.config/opencode/tethoq_images.mjs');
const pluginLoader = join(directory, '.config/opencode/plugins/tethoq_images.js');
await writeFile(join(directory, 'note.txt'), 'A text-only tool result.');
const cfg = { plugin: [[pathToFileURL(pluginLoader).href, { stateRoot, cacheRoot }]], enabled_providers: ['offline'], model: 'offline/glm-5.3-flash', small_model: 'offline/glm-5.3-flash',
  provider: { offline: { npm: '@ai-sdk/openai-compatible', name: 'Offline image QA',
    options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'not-a-real-key' },
    models: { 'glm-5.3-flash': { name: 'Image QA', modalities: { input: ['text', 'image'], output: ['text'] },
      variants: { max: { reasoningEffort: 'max' } }, limit: { context: 1000000, output: 1000 } } } } },
  permission: 'allow', share: 'disabled', autoupdate: false };
cfg.enabled_providers.push('opencode-go');
cfg.provider['opencode-go'] = { ...cfg.provider.offline, name: 'Offline GLM preflight QA' };
const binary = process.env.OPENCODE_TEST_BINARY ?? 'C:/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode.exe';
const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'), OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
    OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_SERVER_PASSWORD: '' },
});
let logs = ''; let spawnError; let bridge; let nativeUrl; let session; let proactive; let toolSession;
server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
server.on('error', error => { spawnError = error; });
try {
  await until(() => { if (spawnError) throw spawnError; return /http:\/\/127\.0\.0\.1:\d+/.test(logs); }, 'OpenCode start');
  nativeUrl = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const adapter = new OpenCodeAdapter({ hostId: 'image-native-qa', baseUrl: nativeUrl, directory, imagePolicy: { stateRoot, cacheRoot, pluginSourcePath: pluginPath }, compactionTimeoutMs: 20_000,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).includes('/summarize')) summaries++;
      if (String(input).includes('/summarize')) console.log(`Summary HTTP ${response.status}: ${await response.clone().text()}`);
      return response;
    },
    localActivity: { databasePath: join(directory, 'data/opencode/opencode.db') }, activityPollIntervalMs: 100 });
  await adapter.subscribe(null, event => { events.push(event); });
  bridge = new AgentBridge({ version: 1, hostId: 'image-native-qa', identity: createHostIdentity(), displayName: 'Image QA', enabledProviders: ['opencode'] }, [adapter]);
  await bridge.start();
  session = await bridge.createSession('opencode', { workingDirectory: directory, title: 'Image recovery without a goal', modelId: 'offline/glm-5.3-flash' });
  assert.equal(await bridge.sessionGoal(session.id), null);
  const fixtureImage = new pngjs.PNG({ width: 16, height: 16 });
  fixtureImage.data.fill(255);
  const png = pngjs.PNG.sync.write(fixtureImage).toString('base64');
  await writeFile(toolImagePath, Buffer.from(png, 'base64'));
  const images = (count, start) => Array.from({ length: count }, (_, i) => ({ id: `image-${start + i}`, name: `image-${start + i}.png`, mimeType: 'image/png', dataBase64: png }));
  const send = async (id, count, start, target = session, modelId = 'offline/glm-5.3-flash') => {
    await bridge.sendMessage(target.id, { requestId: id, content: `Review images ${start} onwards.`, modelId, reasoningEffort: 'max', attachments: images(count, start) });
  };
  for (let batch = 0; batch < 3; batch++) {
    const before = requests.length;
    await send(`batch-${batch}`, 12, batch * 12);
    await until(() => !adapter.hasActiveTurn(session.providerSessionId) && requests.length > before, `batch ${batch} completed`);
    assert.equal(requests.at(-1).count, 12, 'only the new batch belongs in the request');
  }
  let before = requests.length;
  await send('one-new-image', 1, 36);
  await until(() => !adapter.hasActiveTurn(session.providerSessionId) && requests.length > before, 'single image completed');
  assert.equal(requests.at(-1).count, 1);
  before = requests.length;
  await send('text-only', 0, 37);
  await until(() => !adapter.hasActiveTurn(session.providerSessionId) && requests.length > before, 'text completed');
  assert.equal(requests.at(-1).count, 0);
  const raw = await fetch(`${nativeUrl}/session/${session.providerSessionId}/message?directory=${encodeURIComponent(directory)}`).then(response => response.json());
  const originals = raw.flatMap(row => row.parts).filter(part => part.type === 'file' && part.mime === 'image/png');
  assert.equal(originals.length, 37);
  assert.ok(originals.every(part => part.url.startsWith('file:')), 'native history must store cache references, not permanent image blobs');
  before = requests.length;
  await bridge.sendMessage(session.id, { requestId: 'tool-images', content: 'TOOL_IMAGE_QA: explicitly read four images, then read the text note.',
    modelId: 'offline/glm-5.3-flash', reasoningEffort: 'max' });
  await until(() => !adapter.hasActiveTurn(session.providerSessionId) && requests.length >= before + 3, 'tool reads completed');
  assert.deepEqual(requests.slice(before).map(row => row.count), [0, 4, 0], 'explicit image reads are visible once, not on later model steps');
  await appendFile(pluginPath, '\n// Offline QA: simulate a newly installed implementation.\n');
  before = requests.length;
  await send('after-plugin-update', 0, 37);
  await until(() => !adapter.hasActiveTurn(session.providerSessionId) && requests.length > before, 'idle workspace plugin update');
  assert.equal(requests.at(-1).count, 0);
  assert.equal(await bridge.sessionGoal(session.id), null);
  assert.equal(summaries, 0, 'images must never trigger compaction');
  const selection = await adapter.getSession(session.providerSessionId);
  assert.equal(selection.reasoningEffort, 'max');
  const report = { ok: true, paidModelRequests: 0, counts: requests.map(row => row.count), temporaryImages: originals.length,
    model: selection.modelId, reasoning: selection.reasoningEffort, ordinaryTask: true, summaries };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));

} finally {
  if (bridge) await writeFile(join(directory, 'bridge-events.json'), JSON.stringify(bridge.eventsSince(0), null, 2));
  if (nativeUrl && session) await fetch(`${nativeUrl}/session/${session.providerSessionId}/abort`, { method: 'POST' }).catch(() => undefined);
  if (nativeUrl && proactive) await fetch(`${nativeUrl}/session/${proactive.providerSessionId}/abort`, { method: 'POST' }).catch(() => undefined);
  if (nativeUrl && toolSession) await fetch(`${nativeUrl}/session/${toolSession.providerSessionId}/abort`, { method: 'POST' }).catch(() => undefined);
  await bridge?.dispose(); server.kill(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(join(directory, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(directory, 'server.log'), logs);
}
