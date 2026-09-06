'use strict';

/**
 * Disposable real-provider EARS QA. `--probe` lists authenticated audio routes
 * without starting a model turn. A transcription run requires
 * TETHOQ_EARS_QA_MODEL and accepts TETHOQ_EARS_QA_AUDIO_PATH as an override.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { createServer } = require('node:net');
const { homedir, tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const defaultAudioPath = join(homedir(), 'Documents', 'Sound Recordings', 'Recording (1).mp3');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function openCodeCommand() {
  if (process.env.TETHOQ_OPENCODE_COMMAND) return process.env.TETHOQ_OPENCODE_COMMAND;
  if (process.platform === 'win32') {
    const adjacentInstall = join(dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(adjacentInstall)) return adjacentInstall;
  }
  return 'opencode';
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
    if (child.exitCode !== null) throw new Error(`OpenCode EARS QA server exited with ${child.exitCode}`);
    try {
      const response = await fetch(new URL('/global/health', baseUrl), { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('OpenCode EARS QA server did not become ready');
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
          if (session && typeof session === 'object' && session.directory === workingDirectory && typeof session.id === 'string') {
            providerSessionIds.add(session.id);
          }
        }
      }
    } catch {}
    await delay(250);
  } while (Date.now() < deadline);
}

async function cleanupOpenCode(baseUrl, providerSessionIds) {
  const failures = [];
  for (const providerSessionId of providerSessionIds) {
    try {
      const response = await fetch(new URL(`/session/${encodeURIComponent(providerSessionId)}`, baseUrl), {
        method: 'DELETE',
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok && response.status !== 404) failures.push(String(response.status));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) throw new Error(`Could not delete ${failures.length} disposable OpenCode EARS QA task(s)`);
  return providerSessionIds.size;
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function hasAudio(model) {
  return Array.isArray(model.inputModalities) && model.inputModalities.includes('audio');
}

function assertPlausibleTranscript(transcript) {
  const normalized = transcript.trim();
  assert.ok(normalized.length > 0, 'EARS returned an empty transcript');
  assert.ok(normalized.split(/\s+/u).length >= 3, 'EARS returned too little text to plausibly cover the voice note');
  assert.doesNotMatch(
    normalized,
    /^(?:i(?:'m| am)\s+)?transcrib(?:e|ing)|^(?:here(?:'s| is)|this is)\s+(?:the\s+)?transcript|\b(?:cannot|can(?:no|')?t|unable to)\b[^.]{0,80}\b(?:audio|recording|transcrib)/iu,
    'EARS returned a transcription acknowledgement or failure instead of the spoken words',
  );
}

async function uploadAudio(bridge, audioPath) {
  const bytes = await readFile(audioPath);
  assert.ok(bytes.byteLength > 0, 'The EARS QA recording is empty');
  const started = bridge.beginAttachmentUpload({
    name: basename(audioPath),
    mimeType: 'audio/mpeg',
    byteLength: bytes.byteLength,
  });
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += started.chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + started.chunkBytes));
      bridge.appendAttachmentChunk(started.uploadId, offset, chunk.toString('base64'));
    }
    return { ...bridge.completeAttachmentUpload(started.uploadId), byteLength: bytes.byteLength };
  } catch (error) {
    bridge.discardAttachmentUpload(started.uploadId);
    throw error;
  }
}

async function main() {
  const probeOnly = process.argv.includes('--probe');
  const root = join(__dirname, '..', '..', '..');
  const [{ AgentBridge }, { OpenCodeAdapter }, { parseGlobalSessionId }] = await Promise.all([
    import(pathToFileURL(join(root, 'dist', 'apps', 'agent_bridge', 'src', 'bridge.js')).href),
    import(pathToFileURL(join(root, 'dist', 'packages', 'provider_opencode', 'src', 'index.js')).href),
    import(pathToFileURL(join(root, 'dist', 'packages', 'protocol', 'src', 'index.js')).href),
  ]);
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable');
  const configPath = process.env.TETHOQ_QA_CONFIG_PATH ?? join(appData, 'Tethoq', 'bridge.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const qaDirectory = await mkdtemp(join(tmpdir(), 'tethoq-ears-qa-'));
  const qaHostId = `ears-qa-${randomUUID()}`;
  const port = await freePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}/`);
  const qaProviderSessionIds = new Set();
  let openCode;
  let bridge;
  let child;
  let persistedHelpers = {};
  let privacyPersistedBeforeTurn = false;
  let deletedSessions = 0;
  let output;
  try {
    child = spawn(openCodeCommand(), [
      'serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'WARN',
    ], {
      cwd: qaDirectory,
      env: process.env,
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
    bridge = new AgentBridge({
      version: 1,
      hostId: qaHostId,
      displayName: 'Tethoq real EARS QA',
      identity: config.identity,
      enabledProviders: ['opencode'],
    }, [openCode], {
      internalHelperWorkingDirectory: qaDirectory,
      onEarsHelpersChange: async (helpers) => {
        persistedHelpers = { ...helpers };
        for (const helperId of Object.values(helpers)) {
          const { providerSessionId } = parseGlobalSessionId(helperId);
          qaProviderSessionIds.add(providerSessionId);
          const messages = await openCode.getMessages(providerSessionId);
          assert.equal(
            messages.some((message) => message.role === 'user' || message.role === 'assistant'),
            false,
            'The EARS helper privacy marker was not persisted before its first model turn',
          );
          privacyPersistedBeforeTurn = true;
        }
      },
    });
    await bridge.start();

    const [detection, auth, models] = await Promise.all([
      openCode.detect(),
      openCode.getAuthStatus(),
      openCode.listModels(),
    ]);
    assert.equal(detection.available, true, 'The disposable OpenCode server is unavailable');
    assert.equal(auth.authenticated, true, 'OpenCode has no authenticated model provider');
    const audioModels = models.filter(hasAudio);
    const routes = audioModels.map((model) => ({ id: model.id, displayName: model.displayName }));
    if (probeOnly) {
      output = { mode: 'probe', authenticated: true, routes };
    } else {
      const modelId = process.env.TETHOQ_EARS_QA_MODEL?.trim();
    if (!modelId) throw new Error(`Set TETHOQ_EARS_QA_MODEL to one eligible route: ${routes.map((route) => route.id).join(', ') || '(none)'}`);
    const model = audioModels.find((candidate) => candidate.id === modelId);
    assert.ok(model, `The requested EARS QA model is not an authenticated audio route: ${modelId}`);
    const audioPath = process.env.TETHOQ_EARS_QA_AUDIO_PATH ?? defaultAudioPath;
    const uploaded = await uploadAudio(bridge, audioPath);
    const startedAt = Date.now();
    let result;
    try {
      result = await bridge.processEars({
        providerId: 'opencode',
        modelId,
        mode: 'verbatim',
        attachmentIds: [uploaded.attachmentId],
        requestId: `ears-${randomUUID()}`,
      });
    } catch (error) {
      bridge.discardAttachmentUpload(uploaded.attachmentId);
      throw error;
    }
    assert.equal(result.texts.length, 1, 'EARS did not return exactly one transcript for one recording');
    const transcript = result.texts[0]?.trim() ?? '';
    assertPlausibleTranscript(transcript);
    const helperId = persistedHelpers[`opencode:${modelId}`];
    assert.ok(helperId, 'The EARS helper identity was not durably recorded');
    const { providerSessionId } = parseGlobalSessionId(helperId);
    qaProviderSessionIds.add(providerSessionId);
    const helperSession = await openCode.getSession(providerSessionId);
    const helperMessages = await openCode.getMessages(providerSessionId);
    assert.equal(helperSession.modelId, modelId, 'The selected EARS model was not used');
    assert.equal(
      helperMessages.some((message) => message.parts.some((part) => part.type === 'audio')),
      true,
      'The real MP3 did not reach the EARS helper',
    );
    assert.equal(privacyPersistedBeforeTurn, true, 'EARS did not prove persistence-before-send');
    assert.equal(
      bridge.sessions().some((session) => session.title === 'EARS' || session.sessionKind === 'internal'),
      false,
      'An internal EARS helper became visible',
    );
      output = {
        mode: 'transcription',
        modelId,
        source: { path: audioPath, mimeType: 'audio/mpeg', byteLength: uploaded.byteLength },
        transcript,
        transcriptCount: result.texts.length,
        helperHidden: true,
        privacyPersistedBeforeTurn,
        destinationTurns: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
  } finally {
    if (openCode) {
      await discoverQaSessionIds(baseUrl, qaDirectory, qaProviderSessionIds);
      deletedSessions = await cleanupOpenCode(baseUrl, qaProviderSessionIds).catch(() => -1);
    }
    await Promise.allSettled([bridge?.dispose(), openCode?.dispose()]);
    await terminate(child);
    await rm(qaDirectory, { recursive: true, force: true });
  }
  assert.notEqual(deletedSessions, -1, 'Disposable OpenCode EARS QA cleanup failed');
  process.stdout.write(`${JSON.stringify({ ...output, deletedSessions }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
