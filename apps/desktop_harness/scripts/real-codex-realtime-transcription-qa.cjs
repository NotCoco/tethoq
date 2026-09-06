'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const audioPath = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'qa-artifacts', 'ears-qa-825.wav'));
const workingDirectory = path.resolve(__dirname, '../../..');
let child;
let sequence = 0;
let stdout = '';
let stderr = '';
const pending = new Map();
const notifications = [];

function write(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after 20 seconds`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    write({ id, method, params });
  });
}
function notify(method, params) { write({ method, params }); }

function listenToCodex() {
  child.once('error', (error) => {
    for (const handler of pending.values()) handler.reject(error);
    pending.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (;;) {
      const index = stdout.indexOf('\n');
      if (index < 0) break;
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
      } else if (typeof message.method === 'string') {
        notifications.push(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
}

function wavPcm(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') format = {
      encoding: bytes.readUInt16LE(body),
      channels: bytes.readUInt16LE(body + 2),
      sampleRate: bytes.readUInt32LE(body + 4),
      bitsPerSample: bytes.readUInt16LE(body + 14),
    };
    if (id === 'data') pcm = bytes.subarray(body, body + length);
    offset = body + length + (length % 2);
  }
  assert.deepEqual({ encoding: format?.encoding, channels: format?.channels, bitsPerSample: format?.bitsPerSample }, { encoding: 1, channels: 1, bitsPerSample: 16 });
  assert.ok(pcm?.length);
  return { ...format, pcm };
}

async function waitForTranscript(threadId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = notifications.filter((message) => message.method === 'thread/realtime/transcript/done' && message.params?.threadId === threadId);
    const user = matches.findLast((message) => message.params?.role === 'user' && typeof message.params?.text === 'string' && message.params.text.trim());
    if (user) return { text: user.params.text.trim(), matches: matches.map((message) => message.params) };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Codex realtime transcript timed out. Notifications: ${JSON.stringify(notifications.slice(-20))}`);
}

async function main() {
  // Run the root build first; reuse the same host discovery and Windows shim
  // handling as the app instead of requiring a particular global npm layout.
  const { resolveCodexCommand } = await import(pathToFileURL(path.join(workingDirectory, 'dist/packages/provider_codex/src/codex_command.js')).href);
  const { resolveCommand, buildSpawnCommand } = await import(pathToFileURL(path.join(workingDirectory, 'dist/packages/provider_contract/src/command.js')).href);
  const selected = await resolveCodexCommand({ configuredCommand: process.env.TETHOQ_CODEX_COMMAND || undefined });
  const launch = buildSpawnCommand(resolveCommand(selected.command), ['app-server', '--listen', 'stdio://']);
  child = spawn(launch.command, launch.args, { cwd: workingDirectory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  listenToCodex();
  process.stderr.write('Initializing Codex App Server\n');
  await request('initialize', { clientInfo: { name: 'tethoq-qa', title: 'Tethoq QA', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  notify('initialized');
  const [account, features] = await Promise.all([
    request('account/read', { refreshToken: false }),
    request('experimentalFeature/list', { limit: 100 }),
  ]);
  process.stderr.write(`${JSON.stringify({
    accountType: account?.account?.type ?? null,
    requiresOpenaiAuth: account?.requiresOpenaiAuth ?? null,
    realtimeFeatures: (features?.data ?? []).filter((feature) => /realtime|voice|audio/i.test(feature.name ?? feature.displayName ?? '')),
  })}\n`);
  process.stderr.write('Starting ephemeral thread\n');
  const started = await request('thread/start', { cwd: workingDirectory, ephemeral: true, historyMode: 'legacy' });
  const threadId = started?.thread?.id;
  assert.equal(typeof threadId, 'string');
  process.stderr.write(`Starting realtime on ${threadId}\n`);
  await request('thread/realtime/start', {
    threadId,
    outputModality: 'text',
    includeStartupContext: false,
    clientManagedHandoffs: true,
    flushTranscriptTailOnSessionEnd: true,
    version: 'v3',
    transport: { type: 'websocket' },
    realtimeStartInstructions: 'Transcribe the user audio accurately. Do not call tools and do not answer the content.',
  });
  process.stderr.write('Realtime started; appending PCM\n');
  const wav = wavPcm(await readFile(audioPath));
  const samplesPerChunk = Math.max(1, Math.round(wav.sampleRate / 5));
  const bytesPerChunk = samplesPerChunk * wav.channels * 2;
  for (let offset = 0; offset < wav.pcm.length; offset += bytesPerChunk) {
    const chunk = wav.pcm.subarray(offset, Math.min(wav.pcm.length, offset + bytesPerChunk));
    await request('thread/realtime/appendAudio', {
      threadId,
      audio: {
        data: chunk.toString('base64'),
        sampleRate: wav.sampleRate,
        numChannels: wav.channels,
        samplesPerChannel: Math.floor(chunk.length / (wav.channels * 2)),
        itemId: null,
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  process.stderr.write('Stopping realtime\n');
  await request('thread/realtime/stop', { threadId });
  process.stderr.write('Waiting for transcript\n');
  const transcript = await waitForTranscript(threadId);
  process.stdout.write(`${JSON.stringify({ threadId, audioPath, transcript, relevantNotifications: notifications.filter((message) => message.method.startsWith('thread/realtime/')).map((message) => ({ method: message.method, params: message.params })) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${stderr}\n`);
  process.exitCode = 1;
}).finally(() => {
  child?.stdin.end();
  if (child) setTimeout(() => child.kill(), 1000).unref();
});
