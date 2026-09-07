'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

async function updateReleaseAssets(directory, version) {
  const root = path.resolve(directory);
  const name = `Tethoq-Desktop-${version}-x64.exe`;
  const metadataPath = path.join(root, 'latest.yml');
  const metadata = yaml.load(await readFile(metadataPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (metadata?.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error('Update metadata must describe exactly this Desktop version and installer.');
  }
  const entry = metadata.files[0];
  if (entry.url !== name) throw new Error('Update metadata points to a different installer.');
  const installer = path.join(root, name);
  const [info, sha512] = await Promise.all([stat(installer), digest(installer, 'sha512', 'base64')]);
  if (!info.isFile() || info.size === 0 || entry.size !== info.size || entry.sha512 !== sha512) {
    throw new Error('Update installer size or checksum does not match latest.yml.');
  }
  const blockmap = `${installer}.blockmap`;
  if (!(await stat(blockmap)).size) throw new Error('The installer blockmap is missing.');
  return { files: [installer, blockmap, metadataPath], sha512 };
}

module.exports = { updateReleaseAssets };
