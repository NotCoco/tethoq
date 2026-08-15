'use strict';

const { createHash } = require('node:crypto');
const { readFile, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { sourceMetadata } = require('../../../scripts/release/source-metadata.cjs');

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const repositoryRoot = path.resolve(appRoot, '..', '..');
  const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const releaseDirectory = path.resolve(process.argv[2] ?? path.join(appRoot, 'release'));
  const artifactName = `Tethoq-Bridge-${packageJson.version}-x64.exe`;
  const artifactPath = path.join(releaseDirectory, artifactName);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error(`Bridge installer is missing: ${artifactPath}`);

  const artifactSha256 = await sha256(artifactPath);
  const runtimeManifest = JSON.parse(await readFile(path.join(appRoot, 'build', 'bridge-runtime', 'runtime-manifest.json'), 'utf8'));
  const runtimeFiles = {
    node: path.join(appRoot, 'build', 'bridge-runtime', runtimeManifest.runtimes.node.fileName),
    cloudflared: path.join(appRoot, 'build', 'bridge-runtime', runtimeManifest.runtimes.cloudflared.fileName),
  };
  const nodeSha256 = await sha256(runtimeFiles.node);
  const cloudflaredSha256 = await sha256(runtimeFiles.cloudflared);
  if (cloudflaredSha256 !== runtimeManifest.runtimes.cloudflared.sha256) {
    throw new Error('Staged cloudflared does not match its pinned runtime manifest.');
  }

  const source = sourceMetadata(repositoryRoot);
  const manifest = {
    schemaVersion: 1,
    product: 'Tethoq Bridge',
    version: packageJson.version,
    source,
    channel: 'preview',
    artifact: {
      fileName: artifactName,
      platform: 'windows',
      architecture: 'x64',
      format: 'nsis-installer',
      sizeBytes: artifactStat.size,
      sha256: artifactSha256,
    },
    engine: {
      version: runtimeManifest.version,
      source: runtimeManifest.source ?? source,
      entrypoint: runtimeManifest.entrypoint,
      node: { version: runtimeManifest.runtimes.node.version, sha256: nodeSha256 },
      cloudflared: { version: runtimeManifest.runtimes.cloudflared.version, sha256: cloudflaredSha256 },
      includes: runtimeManifest.includes,
      excludes: runtimeManifest.excludes,
    },
  };

  await Promise.all([
    writeFile(path.join(releaseDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(path.join(releaseDirectory, 'SHA256SUMS.txt'), `${artifactSha256}  ${artifactName}\n`, 'ascii'),
  ]);
  process.stdout.write(`Bridge SHA-256 ${artifactSha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
