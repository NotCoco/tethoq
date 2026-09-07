'use strict';

const { spawnSync } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { updateReleaseAssets } = require('./update-release-assets.cjs');

async function main() {
  const directory = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'release'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.source?.revision) || manifest.source.dirty !== false) {
    throw new Error('Build a committed, clean release version before creating its draft.');
  }
  const { files } = await updateReleaseAssets(directory, manifest.version);
  const args = ['release', 'create', `v${manifest.version}`, ...files, path.join(directory, 'release-manifest.json'), path.join(directory, 'SHA256SUMS.txt'),
    '--repo', 'NotCoco/tethoq', '--target', manifest.source.revision, '--draft', '--title', `Tethoq ${manifest.version}`, '--generate-notes'];
  if (manifest.version.startsWith('0.') || manifest.version.includes('-')) args.push('--prerelease');
  const result = spawnSync('gh', args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not create the release draft. Existing releases are never overwritten.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
