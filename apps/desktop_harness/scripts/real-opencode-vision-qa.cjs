'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { copyFile, mkdtemp, readFile, rm } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { PNG } = require('pngjs');

const parentModelId = process.env.TETHOQ_EYES_QA_PARENT_MODEL ?? 'opencode-go/deepseek-v4-pro';
const eyeModels = [
  { providerId: 'opencode', modelId: 'opencode-go/deepseek-v4-pro' },
  { providerId: 'opencode', modelId: 'opencode-go/deepseek-v4-flash-vision-exp' },
  { providerId: 'opencode', modelId: 'opencode-go/glm-5.3-flash' },
  { providerId: 'opencode', modelId: 'opencode-go/gpt-5.6-luna' },
  { providerId: 'direct', modelId: 'google::gemini-3.6-flash' },
  { providerId: 'direct', modelId: 'xai::grok-4.6' },
];
const prompt = 'Use EYES once. Read the card code, status, and both shapes with their colors and positions. Reply in one line.';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function selectedEyeModels() {
  const requested = new Set((process.env.TETHOQ_EYES_QA_MODELS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  return requested.size === 0 ? eyeModels : eyeModels.filter((eye) => requested.has(eye.modelId));
}

function openCodeCommand() {
  if (process.env.TETHOQ_OPENCODE_COMMAND) return process.env.TETHOQ_OPENCODE_COMMAND;
  if (process.platform === 'win32') {
    const adjacentInstall = join(dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(adjacentInstall)) return adjacentInstall;
  }
  return 'opencode';
}

const glyphs = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  a: ['00000', '01110', '00001', '01111', '10001', '10001', '01111'],
  s: ['00000', '01111', '10000', '01110', '00001', '00001', '11110'],
  t: ['00100', '00100', '11111', '00100', '00100', '00101', '00010'],
  u: ['00000', '10001', '10001', '10001', '10001', '10011', '01101'],
};

function setPixel(png, x, y, red, green, blue, alpha = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = (png.width * y + x) * 4;
  png.data[offset] = red;
  png.data[offset + 1] = green;
  png.data[offset + 2] = blue;
  png.data[offset + 3] = alpha;
}

function rectangle(png, left, top, width, height, color) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) setPixel(png, x, y, ...color);
  }
}

function triangle(png, ax, ay, bx, by, cx, cy, color) {
  const edge = (px, py, x1, y1, x2, y2) => (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const first = edge(x, y, ax, ay, bx, by);
      const second = edge(x, y, bx, by, cx, cy);
      const third = edge(x, y, cx, cy, ax, ay);
      if ((first >= 0 && second >= 0 && third >= 0) || (first <= 0 && second <= 0 && third <= 0)) setPixel(png, x, y, ...color);
    }
  }
}

function text(png, value, left, top, scale, color = [20, 24, 31]) {
  let cursor = left;
  for (const character of value) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Missing fixture glyph ${character}`);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') rectangle(png, cursor + column * scale, top + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

function fixtureAttachment() {
  const png = new PNG({ width: 800, height: 480, colorType: 6 });
  rectangle(png, 0, 0, png.width, png.height, [247, 248, 250]);
  rectangle(png, 28, 28, 125, 125, [23, 94, 214]);
  triangle(png, 642, 438, 770, 438, 770, 310, [220, 38, 38]);
  text(png, 'EYES-427', 160, 175, 10);
  text(png, 'Status: READY', 160, 300, 6);
  const bytes = PNG.sync.write(png);
  return {
    name: 'test-card.png',
    mimeType: 'image/png',
    dataBase64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Could not reserve an OpenCode QA port');
  return port;
}

async function waitForOpenCode(baseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode QA server exited with ${child.exitCode}`);
    try {
      const response = await fetch(new URL('/experimental/tool/ids', baseUrl), { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const tools = await response.json();
        assert.ok(Array.isArray(tools) && tools.includes('uar_mesh_tethoq_turn_support'), 'OpenCode did not load turn support');
        return;
      }
    } catch {}
    await delay(200);
  }
  throw new Error('OpenCode QA server did not become ready');
}

function messageText(message) {
  return message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
}

function toolParts(messages) {
  return messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool'));
}

function assertVisualFacts(answer) {
  const normalized = answer.toUpperCase().replaceAll('_', ' ');
  assert.match(normalized, /EYES\s*-?\s*427/u);
  assert.match(normalized, /BLUE/u);
  assert.match(normalized, /SQUARE/u);
  assert.match(normalized, /TOP\s*-?\s*LEFT/u);
  assert.match(normalized, /RED/u);
  assert.match(normalized, /TRIANGLE/u);
  assert.match(normalized, /BOTTOM\s*-?\s*RIGHT/u);
  assert.match(normalized, /READY/u);
}

async function waitForParentResult(bridge, sessionId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    try {
      latest = (await bridge.openSession(sessionId, undefined, 200, true)).messages;
      const answers = latest.filter((message) => message.role === 'assistant' && message.status === 'completed').map(messageText).filter(Boolean);
      const eyesCalls = toolParts(latest).filter((part) => part.name.toLowerCase() === 'uar_mesh_tethoq_turn_support');
      if (answers.length && eyesCalls.some((part) => part.status === 'completed')) return { messages: latest, answer: answers.at(-1), eyesCalls };
    } catch {}
    await delay(750);
  }
  const tail = latest.slice(-6).map((message) => ({ role: message.role, status: message.status, text: messageText(message).slice(0, 160) }));
  throw new Error(`Real EYES turn timed out: ${JSON.stringify(tail)}`);
}

async function cleanupOpenCode(baseUrl, providerSessionIds) {
  const failures = [];
  for (const providerSessionId of providerSessionIds) {
    try {
      const url = new URL(`/session/${encodeURIComponent(providerSessionId)}`, baseUrl);
      const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(8_000) });
      if (!response.ok && response.status !== 404) failures.push(`${response.status}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) throw new Error(`Could not delete ${failures.length} disposable OpenCode QA task(s)`);
  return providerSessionIds.size;
}

async function discoverQaSessionIds(baseUrl, workingDirectory, providerSessionIds) {
  const deadline = Date.now() + 5_000;
  do {
    try {
      const url = new URL('/session', baseUrl);
      url.searchParams.set('limit', '200');
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const sessions = response.ok ? await response.json() : [];
      if (Array.isArray(sessions)) {
        for (const session of sessions) {
          if (session && typeof session === 'object' && session.directory === workingDirectory && typeof session.id === 'string') providerSessionIds.add(session.id);
        }
      }
    } catch {}
    await delay(250);
  } while (Date.now() < deadline);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const root = join(__dirname, '..', '..', '..');
  const [{ AgentBridge }, { MeshToolGateway }, { OpenCodeAdapter }, { DirectApiProviderAdapter }, { parseGlobalSessionId }] = await Promise.all([
    import(pathToFileURL(join(root, 'dist', 'apps', 'agent_bridge', 'src', 'bridge.js')).href),
    import(pathToFileURL(join(root, 'dist', 'apps', 'agent_bridge', 'src', 'mesh_tools.js')).href),
    import(pathToFileURL(join(root, 'dist', 'packages', 'provider_opencode', 'src', 'index.js')).href),
    import(pathToFileURL(join(root, 'dist', 'packages', 'provider_direct', 'src', 'index.js')).href),
    import(pathToFileURL(join(root, 'dist', 'packages', 'protocol', 'src', 'index.js')).href),
  ]);
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable');
  const configPath = process.env.TETHOQ_QA_CONFIG_PATH ?? join(appData, 'Tethoq', 'bridge.json');
  const walletPath = join(dirname(configPath), 'direct-api-wallet.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const requiresDirect = selectedEyeModels().some((eye) => eye.providerId === 'direct');
  const qaDirectory = await mkdtemp(join(tmpdir(), 'tethoq-eyes-qa-'));
  const qaWalletPath = join(qaDirectory, 'direct-api-wallet.json');
  if (requiresDirect) await copyFile(walletPath, qaWalletPath).catch(() => undefined);
  const qaHostId = `eyes-qa-${randomUUID()}`;
  const runtimePath = join(qaDirectory, 'mesh-runtime.json');
  const port = await freePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}/`);
  let bridge;
  let gateway;
  let openCode;
  let direct;
  let child;
  const results = [];
  const qaProviderSessionIds = new Set();
  const helperByParent = new Map();
  const eyesStartedForParent = new Set();
  let deletedSessions = 0;
  try {
    gateway = new MeshToolGateway(qaHostId, async (sessionId, tool, input) => {
      if (!bridge) throw new Error('QA Bridge is not ready');
      if (tool === 'tethoq_turn_support') {
        assert.equal(eyesStartedForParent.has(sessionId), false, 'QA permits only one EYES request per parent');
        eyesStartedForParent.add(sessionId);
        const question = typeof input.request === 'string' ? input.request : '';
        const result = await bridge.askVisionProxy(sessionId, question);
        const helperProviderSessionId = parseGlobalSessionId(result.helperSessionId).providerSessionId;
        qaProviderSessionIds.add(helperProviderSessionId);
        helperByParent.set(sessionId, helperProviderSessionId);
        return { observation: result.observation };
      }
      return await bridge.executeClientTool(sessionId, tool, input);
    }, { runtimePath });
    await gateway.listen();
    child = spawn(openCodeCommand(), [
      'serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'WARN',
    ], {
      cwd: qaDirectory,
      env: { ...process.env, UAR_MESH_RUNTIME: runtimePath },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let serverError = '';
    child.once('error', (error) => { serverError = error instanceof Error ? error.message : String(error); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { serverError = `${serverError}${chunk}`.slice(-4_000); });
    await waitForOpenCode(baseUrl, child).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${serverError ? `: ${serverError}` : ''}`);
    });

    openCode = new OpenCodeAdapter({ hostId: qaHostId, baseUrl: baseUrl.href, directory: qaDirectory });
    if (requiresDirect) direct = new DirectApiProviderAdapter({
      hostId: qaHostId,
      statePath: qaWalletPath,
      encryptionSecret: config.identity.privateKeyPem,
      environment: process.env,
    });
    bridge = new AgentBridge({
      version: 1,
      hostId: qaHostId,
      displayName: 'Tethoq real EYES QA',
      identity: config.identity,
      enabledProviders: requiresDirect ? ['opencode', 'direct'] : ['opencode'],
    }, direct ? [openCode, direct] : [openCode], { internalHelperWorkingDirectory: qaDirectory });
    bridge.configureClientTooling(gateway);
    await bridge.start();

    const parentModel = (await openCode.listModels()).find((model) => model.id === parentModelId);
    assert.ok(parentModel, `The QA parent model is unavailable: ${parentModelId}`);
    const parentSupportsImages = parentModel.inputModalities?.includes('image') === true;
    const availableTargets = (await bridge.visionProxyTargets()).targets;
    const fixture = fixtureAttachment();

    for (const eye of selectedEyeModels()) {
      const target = availableTargets.find((candidate) => candidate.providerId === eye.providerId);
      const available = target?.models.some((model) => model.id === eye.modelId) === true;
      if (!available) {
        results.push({ ...eye, state: 'blocked', reason: eye.providerId === 'direct' ? 'API key is missing, invalid, or could not be verified' : 'model is unavailable' });
        continue;
      }
      const startedAt = Date.now();
      const parent = await bridge.createSession('opencode', {
        workingDirectory: qaDirectory,
        title: `Tethoq EYES QA ${eye.modelId}`,
        modelId: parentModelId,
      });
      qaProviderSessionIds.add(parent.providerSessionId);
      // This disposable task needs only EYES. Avoid billing the parent for the
      // user's full coding/MCP tool catalogue during a one-line visual test.
      const permissionsUrl = new URL(`/session/${encodeURIComponent(parent.providerSessionId)}`, baseUrl);
      permissionsUrl.searchParams.set('directory', qaDirectory);
      const restricted = await fetch(permissionsUrl, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permission: [
          { permission: '*', pattern: '*', action: 'deny' },
          { permission: 'uar_mesh_tethoq_turn_support', pattern: '*', action: 'allow' },
        ] }),
        signal: AbortSignal.timeout(8_000),
      });
      assert.equal(restricted.ok, true, 'Could not restrict the disposable parent tools');
      await bridge.configureVisionProxy(parent.id, eye);
      await bridge.sendMessage(parent.id, {
        requestId: `eyes-${randomUUID()}`,
        content: prompt,
        modelId: parentModelId,
        attachments: [fixture],
      });
      const outcome = await waitForParentResult(bridge, parent.id);
      assertVisualFacts(outcome.answer);
      assert.equal(outcome.eyesCalls.length, 1, 'The parent must call EYES exactly once');
      const parentMessages = await openCode.getMessages(parent.providerSessionId);
      assert.equal(
        parentMessages.some((message) => message.parts.some((part) => part.type === 'image')),
        false,
        'Configured EYES must keep the raw image away from the parent model',
      );
      const serialized = JSON.stringify(outcome.messages);
      assert.doesNotMatch(serialized, /You are EYES:|internalPurpose|vision_proxy|helperSessionId|<tethoq_response_guidance>/u);
      const helperProviderSessionId = helperByParent.get(parent.id);
      assert.ok(helperProviderSessionId, 'The EYES helper was not correlated to its parent');
      const helperAdapter = eye.providerId === 'direct' ? direct : openCode;
      const helperSession = await helperAdapter.getSession(helperProviderSessionId);
      assert.equal(helperSession.modelId, eye.modelId, 'The selected EYES model was not used');
      const helperMessages = await helperAdapter.getMessages(helperProviderSessionId);
      assert.equal(
        helperMessages.some((message) => message.parts.some((part) => part.type === 'image')),
        true,
        'The real current-turn image did not reach the EYES helper',
      );
      assert.equal(bridge.sessions().some((session) => session.title === 'Visual support' || session.sessionKind === 'internal'), false, 'An internal EYES helper became visible');
      const elapsedMs = Date.now() - startedAt;
      results.push({ ...eye, state: 'passed', parentSupportsImages, elapsedMs, answer: outcome.answer });
      process.stderr.write(`EYES passed: ${eye.modelId} (${(elapsedMs / 1000).toFixed(1)}s)\n`);
      process.stderr.write(`Answer: ${outcome.answer}\n`);
    }
  } finally {
    if (openCode) {
      await discoverQaSessionIds(baseUrl, qaDirectory, qaProviderSessionIds);
      deletedSessions = await cleanupOpenCode(baseUrl, qaProviderSessionIds).catch(() => -1);
    }
    // Bridge owns its adapters. Disposing them twice can race wallet writes
    // against scratch-directory removal on Windows.
    await Promise.allSettled([
      gateway?.close(),
      bridge ? bridge.dispose() : Promise.allSettled([direct?.dispose(), openCode?.dispose()]),
    ]);
    await terminate(child);
    await rm(qaDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  assert.notEqual(deletedSessions, -1, 'Disposable OpenCode QA cleanup failed');
  process.stdout.write(`${JSON.stringify({ parentModelId, fixture: ['EYES-427', 'blue square at top-left', 'red triangle at bottom-right', 'Status: READY'], results, deletedSessions }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
