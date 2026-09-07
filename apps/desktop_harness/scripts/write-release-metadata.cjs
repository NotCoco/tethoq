'use strict';

const { createHash } = require('node:crypto');
const { readFile, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { sourceMetadata } = require('../../../scripts/release/source-metadata.cjs');
const { updateReleaseAssets } = require('./update-release-assets.cjs');

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const repositoryRoot = path.resolve(appRoot, '..', '..');
  const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const artifactName = `Tethoq-Desktop-${packageJson.version}-x64.exe`;
  const configuredDirectory = process.argv[2];
  const releaseDirectory = configuredDirectory ? path.resolve(configuredDirectory) : path.join(appRoot, 'release');
  const artifactPath = path.join(releaseDirectory, artifactName);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error(`Desktop installer is missing: ${artifactPath}`);

  const artifactSha256 = await sha256(artifactPath);
  const updateAssets = await updateReleaseAssets(releaseDirectory, packageJson.version);
  const packagedBridgeRoot = path.join(releaseDirectory, 'win-unpacked', 'resources', 'bridge-companion');
  const stagedBridgeRoot = path.join(appRoot, 'build', 'bridge-companion');
  const bridgeRoot = await stat(packagedBridgeRoot).then(
    (value) => value.isDirectory() ? packagedBridgeRoot : stagedBridgeRoot,
    () => stagedBridgeRoot,
  );
  const bridgePackage = JSON.parse(await readFile(path.resolve(appRoot, '..', 'desktop_companion', 'package.json'), 'utf8'));
  const bridgeExecutable = path.join(bridgeRoot, 'Tethoq Bridge.exe');
  const bridgeAsar = path.join(bridgeRoot, 'resources', 'app.asar');
  const bridgeRuntimeManifestPath = path.join(bridgeRoot, 'resources', 'bridge', 'runtime-manifest.json');
  const [bridgeExecutableStat, bridgeAsarStat, bridgeRuntimeManifest] = await Promise.all([
    stat(bridgeExecutable),
    stat(bridgeAsar),
    readFile(bridgeRuntimeManifestPath, 'utf8').then(JSON.parse),
  ]);
  if (!bridgeExecutableStat.isFile() || !bridgeAsarStat.isFile()) {
    throw new Error('The staged Tethoq Bridge companion is incomplete.');
  }
  const [bridgeExecutableSha256, bridgeAsarSha256, bridgeRuntimeManifestSha256] = await Promise.all([
    sha256(bridgeExecutable),
    sha256(bridgeAsar),
    sha256(bridgeRuntimeManifestPath),
  ]);
  const source = sourceMetadata(repositoryRoot);
  const manifest = {
    schemaVersion: 1,
    product: 'Tethoq Desktop',
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
    updates: { provider: 'github', repository: 'NotCoco/tethoq', metadata: 'latest.yml', sha512: updateAssets.sha512 },
    includes: {
      bridge: {
        product: 'Tethoq Bridge',
        version: bridgePackage.version,
        source: bridgeRuntimeManifest.source ?? source,
        layout: 'resources/bridge-companion',
        executable: {
          path: 'resources/bridge-companion/Tethoq Bridge.exe',
          sizeBytes: bridgeExecutableStat.size,
          sha256: bridgeExecutableSha256,
        },
        appAsar: {
          path: 'resources/bridge-companion/resources/app.asar',
          sizeBytes: bridgeAsarStat.size,
          sha256: bridgeAsarSha256,
        },
        runtimeManifest: {
          path: 'resources/bridge-companion/resources/bridge/runtime-manifest.json',
          sha256: bridgeRuntimeManifestSha256,
        },
        engine: {
          version: bridgeRuntimeManifest.version,
          nodeVersion: bridgeRuntimeManifest.runtimes.node.version,
          cloudflaredVersion: bridgeRuntimeManifest.runtimes.cloudflared.version,
          cloudflaredSha256: bridgeRuntimeManifest.runtimes.cloudflared.sha256,
        },
      },
      chromiumWorkspace: true,
      workflowRecorder: true,
      connectorSdk: true,
    },
  };

  await Promise.all([
    writeFile(path.join(releaseDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(path.join(releaseDirectory, 'SHA256SUMS.txt'), `${artifactSha256}  ${artifactName}\n`, 'ascii'),
  ]);
  process.stdout.write(`Desktop SHA-256 ${artifactSha256}; embedded Bridge ${bridgePackage.version} ${bridgeExecutableSha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
