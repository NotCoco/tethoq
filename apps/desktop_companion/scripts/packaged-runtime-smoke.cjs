'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { resolveBridgeEntrypoint, resolveBridgeRuntime } = require('../src/pairing_process.cjs');

const unpackedRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'release', 'win-unpacked'));
const resourcesPath = path.join(unpackedRoot, 'resources');
const appAsar = path.join(resourcesPath, 'app.asar');
const manifestPath = path.join(resourcesPath, 'bridge', 'runtime-manifest.json');
assert.ok(statSync(appAsar).isFile(), 'Packaged companion is missing app.asar.');
assert.ok(statSync(manifestPath).isFile(), 'Packaged companion is missing the Bridge runtime manifest.');
for (const legalFile of [
  path.join(resourcesPath, 'legal', 'TETHOQ-LICENSE.txt'),
  path.join(resourcesPath, 'legal', 'THIRD_PARTY_NOTICES.md'),
  path.join(resourcesPath, 'bridge', 'TETHOQ-LICENSE.txt'),
  path.join(resourcesPath, 'bridge', 'THIRD_PARTY_NOTICES.md'),
]) {
  assert.ok(statSync(legalFile).isFile(), `Packaged companion is missing legal notice: ${legalFile}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(typeof manifest.source?.revision, 'string', 'Packaged Bridge manifest is missing its source revision.');
const executable = resolveBridgeRuntime({ resourcesPath });
const entrypoint = resolveBridgeEntrypoint({ resourcesPath });
assert.equal(executable, path.join(resourcesPath, 'bridge', 'runtime', 'node.exe'));
assert.equal(entrypoint, path.join(resourcesPath, 'bridge', 'app', 'apps', 'agent_bridge', 'src', 'main.js'));
for (const candidate of [executable, entrypoint]) assert.ok(statSync(candidate).isFile(), `Missing packaged Bridge file: ${candidate}`);

const cloudflared = path.join(resourcesPath, 'bridge', manifest.runtimes.cloudflared.fileName);
assert.ok(statSync(cloudflared).isFile(), 'Packaged companion is missing cloudflared.');
const cloudflaredSha256 = createHash('sha256').update(readFileSync(cloudflared)).digest('hex');
assert.equal(cloudflaredSha256, manifest.runtimes.cloudflared.sha256);

const help = spawnSync(executable, [entrypoint, '--help'], {
  cwd: path.dirname(entrypoint),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15_000,
});
assert.equal(help.status, 0, help.stderr || help.stdout);
assert.match(`${help.stdout}\n${help.stderr}`, /Usage: agent-bridge/);
process.stdout.write(`Packaged Bridge runtime resolved and executed: ${entrypoint}\n`);
