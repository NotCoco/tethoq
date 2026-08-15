'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function sourceMetadata(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const revision = process.env.TETHOQ_SOURCE_REVISION?.trim()
    || process.env.GITHUB_SHA?.trim()
    || git(root, ['rev-parse', 'HEAD'])
    || 'unknown';
  const tag = process.env.TETHOQ_SOURCE_TAG?.trim()
    || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME?.trim() : undefined)
    || git(root, ['describe', '--tags', '--exact-match']);
  const configuredDirty = process.env.TETHOQ_SOURCE_DIRTY?.trim().toLowerCase();
  const status = git(root, ['status', '--porcelain']);
  const dirty = configuredDirty === 'true'
    ? true
    : configuredDirty === 'false'
      ? false
      : status === undefined
        ? null
        : status.length > 0;
  return {
    revision,
    tag: tag || null,
    dirty,
  };
}

if (require.main === module) {
  const repositoryRoot = process.argv[2] ?? path.resolve(__dirname, '..', '..');
  process.stdout.write(`${JSON.stringify(sourceMetadata(repositoryRoot))}\n`);
}

module.exports = { sourceMetadata };
