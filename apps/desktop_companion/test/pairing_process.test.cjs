'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CONTROL_PORT_PREFIX,
  PAIRING_CONFIRMED_MARKER,
  PairingProcessManager,
  hasPairingConfirmedMarker,
  isSafePairingPageUrl,
  pairingQrDataUrl,
  resolveBridgeEntrypoint,
  resolveBridgeRuntime,
} = require('../src/pairing_process.cjs');

const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h25v25H0z"/><path stroke="#000000" d="M2 2.5h7m3 0h1"/></svg>';
const QR_PAGE = `<!doctype html><div class="qr">${QR_SVG}</div>`;
const PAGE_URL = 'http://127.0.0.1:4321/pair/abcdefghijklmnopqrstuvwxyz_12345';

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = pid;
  return child;
}

function fakePage() {
  return {
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => QR_PAGE,
  };
}

async function boot(manager, child, port = 43123) {
  const started = manager.startEngine();
  child.stdout.emit('data', Buffer.from(`${CONTROL_PORT_PREFIX}${port}\n`));
  await started;
}

test('pairing page URL accepts only an opaque loopback route', () => {
  assert.equal(isSafePairingPageUrl(PAGE_URL), true);
  assert.equal(isSafePairingPageUrl(PAGE_URL.replace('http:', 'https:')), false);
  assert.equal(isSafePairingPageUrl(PAGE_URL.replace('127.0.0.1', 'evil.test')), false);
  assert.equal(isSafePairingPageUrl('http://127.0.0.1:4321/pair/short'), false);
});

test('legacy marker parser accepts only the fixed complete marker line', () => {
  assert.equal(PAIRING_CONFIRMED_MARKER, 'TETHOQ_PAIRING_CONFIRMED');
  assert.equal(hasPairingConfirmedMarker(`ready\n${PAIRING_CONFIRMED_MARKER}\n`), true);
  assert.equal(hasPairingConfirmedMarker(`ready ${PAIRING_CONFIRMED_MARKER}\n`), false);
});

test('runtime resolution prefers packaged Node and packaged Bridge entrypoint', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'tethoq-runtime-'));
  const runtime = path.join(temp, 'bridge', 'runtime', 'node.exe');
  const entrypoint = path.join(temp, 'bridge', 'app', 'apps', 'agent_bridge', 'src', 'main.js');
  mkdirSync(path.dirname(runtime), { recursive: true });
  mkdirSync(path.dirname(entrypoint), { recursive: true });
  writeFileSync(runtime, 'node');
  writeFileSync(entrypoint, 'bridge');
  assert.equal(resolveBridgeRuntime({ resourcesPath: temp, fallbackExecutable: 'electron.exe' }), runtime);
  assert.equal(resolveBridgeEntrypoint({ resourcesPath: temp }), entrypoint);
  assert.equal(resolveBridgeRuntime({ resourcesPath: path.join(temp, 'missing'), fallbackExecutable: 'electron.exe' }), 'electron.exe');
});

test('manager starts one persistent engine with an opaque environment token', async () => {
  const child = fakeChild();
  const spawns = [];
  const requests = [];
  const manager = new PairingProcessManager({
    executable: 'node.exe',
    entrypoint: 'C:\\bridge\\main.js',
    cloudflaredPath: 'C:\\bridge\\cloudflared.exe',
    electronRuntime: false,
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options });
      return child;
    },
    controlRequest: async (request) => {
      requests.push(request);
      return { state: 'running', pairingState: 'idle', pairedDeviceCount: 0 };
    },
    stopProcess: async () => {},
  });
  const first = manager.startEngine();
  assert.deepEqual(manager.status(), { state: 'booting' });
  child.stdout.emit('data', Buffer.from('ignored output\nTETHOQ_COMPANION_CONTROL_PORT=43123\n'));
  await first;
  await manager.startEngine();
  assert.deepEqual(manager.status(), { state: 'running' });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['C:\\bridge\\main.js', '--companion-control', '--host', '127.0.0.1', '--port', '0']);
  assert.equal(spawns[0].options.env.UAR_BRIDGE_PORT, '0');
  assert.equal(spawns[0].options.env.UAR_CLOUDFLARED_COMMAND, 'C:\\bridge\\cloudflared.exe');
  assert.match(spawns[0].options.env.TETHOQ_COMPANION_CONTROL_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(spawns[0].args.join(' ').includes(spawns[0].options.env.TETHOQ_COMPANION_CONTROL_TOKEN), false);
  assert.equal('ELECTRON_RUN_AS_NODE' in spawns[0].options.env, false);
  assert.equal(requests[0].pathname, '/status');
  assert.equal(requests[0].token, spawns[0].options.env.TETHOQ_COMPANION_CONTROL_TOKEN);
  await manager.shutdown();
});

test('pairing commands reuse the persistent child and sanitize the local QR page', async () => {
  const child = fakeChild();
  const spawns = [];
  const requests = [];
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const manager = new PairingProcessManager({
    executable: 'electron.exe',
    entrypoint: 'C:\\bridge\\main.js',
    electronRuntime: true,
    spawnProcess: (...args) => { spawns.push(args); return child; },
    controlRequest: async (request) => {
      requests.push(request);
      if (request.pathname === '/pair/start') return { state: 'ready', pageUrl: PAGE_URL, expiresAt: expiry };
      return { state: 'running', pairingState: 'idle', pairedDeviceCount: 0 };
    },
    fetchPage: async () => fakePage(),
    stopProcess: async () => {},
  });
  await boot(manager, child);
  const result = await manager.start();
  assert.match(result.qrDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal((await manager.start()).pageUrl, PAGE_URL);
  assert.equal(spawns.length, 1);
  assert.equal(requests.filter((item) => item.pathname === '/pair/start').length, 1);
  assert.equal(spawns[0][2].env.ELECTRON_RUN_AS_NODE, '1');
  await manager.cancel();
  assert.deepEqual(manager.status(), { state: 'running' });
  assert.equal(requests.at(-1).pathname, '/pair/cancel');
  assert.equal(spawns.length, 1);
  await manager.shutdown();
});

test('authenticated status polling promotes a ready pairing to paired', async () => {
  const child = fakeChild();
  let paired = false;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const states = [];
  const manager = new PairingProcessManager({
    executable: 'node.exe',
    entrypoint: 'C:\\bridge\\main.js',
    spawnProcess: () => child,
    controlRequest: async ({ pathname }) => {
      if (pathname === '/pair/start') return { state: 'ready', pageUrl: PAGE_URL, expiresAt: expiry };
      return { state: 'running', pairingState: paired ? 'paired' : 'idle', pairedDeviceCount: paired ? 1 : 0 };
    },
    fetchPage: async () => fakePage(),
    stopProcess: async () => {},
    onStateChange: (status) => states.push(status.state),
  });
  await boot(manager, child);
  await manager.start();
  paired = true;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(manager.status(), { state: 'paired' });
  assert.ok(states.includes('paired'));
  await manager.shutdown();
});

test('unexpected exit schedules one bounded restart and never spawns duplicates', async () => {
  const children = [fakeChild(1), fakeChild(2)];
  const spawns = [];
  const manager = new PairingProcessManager({
    executable: 'node.exe',
    entrypoint: 'C:\\bridge\\main.js',
    spawnProcess: (...args) => { spawns.push(args); return children[spawns.length - 1]; },
    controlRequest: async () => ({ state: 'running', pairingState: 'idle', pairedDeviceCount: 0 }),
    stopProcess: async () => {},
    restartBaseDelayMs: 5,
    restartMaxDelayMs: 5,
  });
  await boot(manager, children[0], 43123);
  children[0].exitCode = 9;
  children[0].emit('exit', 9);
  assert.deepEqual(manager.status(), { state: 'restarting' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(spawns.length, 2);
  const concurrent = manager.startEngine();
  children[1].stdout.emit('data', Buffer.from(`${CONTROL_PORT_PREFIX}43124\n`));
  await concurrent;
  assert.equal(spawns.length, 2);
  await manager.shutdown();
});

test('explicit shutdown requests graceful control shutdown before forced cleanup', async () => {
  const child = fakeChild();
  const actions = [];
  const manager = new PairingProcessManager({
    executable: 'node.exe',
    entrypoint: 'C:\\bridge\\main.js',
    spawnProcess: () => child,
    controlRequest: async ({ pathname }) => { actions.push(`request:${pathname}`); return { state: 'running' }; },
    stopProcess: async () => { actions.push('forced-stop'); },
    shutdownGraceMs: 0,
  });
  await boot(manager, child);
  await manager.shutdown();
  assert.deepEqual(actions, ['request:/status', 'request:/shutdown', 'forced-stop']);
  assert.deepEqual(manager.status(), { state: 'stopped' });
});

test('pairing QR extraction rebuilds only the expected SVG structure', () => {
  const decoded = Buffer.from(pairingQrDataUrl(QR_PAGE).split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, QR_SVG);
  assert.throws(() => pairingQrDataUrl('<div class="qr"><svg><script>alert(1)</script></svg></div>'), /invalid/);
});
