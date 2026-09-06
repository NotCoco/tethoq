'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { homedir } = require('node:os');
const { join } = require('node:path');

const grokBinary = join(homedir(), '.grok', 'bin', 'grok.exe');
const child = spawn(grokBinary, ['agent', '--no-leader', 'stdio'], {
  cwd: join(__dirname, '..', '..', '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
let settled = false;

function safeValue(value, path = '') {
  if (Array.isArray(value)) return value.map((entry, index) => safeValue(entry, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const nextPath = path ? `${path}.${key}` : key;
    return [key, /(?:secret|token|email|account|user)/iu.test(key) ? '[redacted]' : safeValue(entry, nextPath)];
  }));
}

function relevantEntries(value, path = '$', matches = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => relevantEntries(entry, `${path}[${index}]`, matches));
    return matches;
  }
  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      const nextPath = `${path}.${key}`;
      if (/(?:audio|voice|speech|transcri|dictat)/iu.test(key)) matches.push({ path: nextPath, value: safeValue(entry, nextPath) });
      relevantEntries(entry, nextPath, matches);
    });
    return matches;
  }
  if (typeof value === 'string' && /(?:audio|voice|speech|transcri|dictat)/iu.test(value)) matches.push({ path, value });
  return matches;
}

async function shutdown() {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  process.stderr.write(`Grok ACP initialize timed out. ${stderr}\n`);
  process.exitCode = 1;
  void shutdown();
}, 15_000);

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) return;
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== 1) continue;
    settled = true;
    clearTimeout(timeout);
    if (message.error) {
      process.stderr.write(`${JSON.stringify(safeValue(message.error), null, 2)}\n${stderr}\n`);
      process.exitCode = 1;
    } else {
      const result = safeValue(message.result ?? {});
      process.stdout.write(`${JSON.stringify({
        protocolVersion: result.protocolVersion ?? null,
        agentCapabilities: result.agentCapabilities ?? null,
        authMethods: result.authMethods ?? null,
        agentInfo: result.agentInfo ?? null,
        metaKeys: result._meta && typeof result._meta === 'object' ? Object.keys(result._meta) : [],
        audioOrDictationEntries: relevantEntries(result),
        initializeResponse: result,
      }, null, 2)}\n`);
    }
    void shutdown();
    return;
  }
});

child.on('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'tethoq-qa', title: 'Tethoq QA', version: '0.1.0' },
    _meta: { clientType: 'tethoq-qa', clientIdentifier: 'tethoq-qa' },
  },
})}\n`);
