'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function namedFiles(root, name) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...namedFiles(candidate, name));
    else if (entry.name === name) matches.push(candidate);
  }
  return matches;
}

function verifyEmbeddedBridge(unpackedRoot) {
  const resources = path.join(unpackedRoot, 'resources');
  const companionRoot = path.join(resources, 'bridge-companion');
  const executable = path.join(companionRoot, 'Tethoq Bridge.exe');
  const companionAsar = path.join(companionRoot, 'resources', 'app.asar');
  const runtimeRoot = path.join(companionRoot, 'resources', 'bridge');
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');

  assert.ok(statSync(executable).isFile(), 'Desktop is missing the independently launchable Bridge executable.');
  assert.ok(statSync(companionAsar).isFile(), 'Desktop is missing the Bridge companion app.asar.');
  assert.ok(statSync(manifestPath).isFile(), 'Desktop is missing the Bridge runtime manifest.');
  assert.ok(statSync(path.join(runtimeRoot, 'TETHOQ-LICENSE.txt')).isFile(), 'Embedded Bridge is missing the Tethoq license.');
  assert.ok(statSync(path.join(runtimeRoot, 'THIRD_PARTY_NOTICES.md')).isFile(), 'Embedded Bridge is missing third-party notices.');
  assert.equal(existsSync(path.join(resources, 'bridge')), false, 'Desktop still contains the obsolete Bridge archive resource.');
  assert.deepEqual(namedFiles(resources, 'Tethoq Bridge.exe'), [executable], 'Desktop must embed exactly one Bridge companion.');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'Tethoq Bridge Engine');
  assert.equal(typeof manifest.source?.revision, 'string', 'Embedded Bridge manifest is missing its source revision.');
  const node = path.join(runtimeRoot, manifest.runtimes.node.fileName);
  const entrypoint = path.join(runtimeRoot, manifest.entrypoint);
  const cloudflared = path.join(runtimeRoot, manifest.runtimes.cloudflared.fileName);
  const cloudflaredLicense = path.join(runtimeRoot, manifest.runtimes.cloudflared.licenseFileName);
  for (const candidate of [node, entrypoint, cloudflared, cloudflaredLicense]) {
    assert.ok(statSync(candidate).isFile(), `Desktop is missing a packaged Bridge runtime file: ${candidate}`);
  }
  assert.equal(sha256(cloudflared), manifest.runtimes.cloudflared.sha256, 'Bundled cloudflared does not match the pinned hash.');
  assert.equal(sha256(cloudflaredLicense), manifest.runtimes.cloudflared.licenseSha256, 'Bundled cloudflared license does not match the pinned hash.');

  const help = spawnSync(node, [entrypoint, '--help'], {
    cwd: path.dirname(entrypoint),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(`${help.stdout}\n${help.stderr}`, /Usage: agent-bridge/);

  return {
    version: manifest.version,
    executable: path.relative(resources, executable),
    appAsar: path.relative(resources, companionAsar),
    entrypoint: path.relative(resources, entrypoint),
    cloudflaredSha256: manifest.runtimes.cloudflared.sha256,
  };
}

if (require.main === module) {
  const appRoot = path.resolve(__dirname, '..');
  const unpackedRoot = path.resolve(process.argv[2] ?? path.join(appRoot, 'release', 'win-unpacked'));
  const result = verifyEmbeddedBridge(unpackedRoot);
  process.stdout.write(`Embedded Tethoq Bridge verified: ${JSON.stringify(result)}\n`);
}

module.exports = { verifyEmbeddedBridge };
