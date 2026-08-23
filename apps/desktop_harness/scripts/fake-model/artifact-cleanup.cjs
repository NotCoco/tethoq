'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove only old PNG captures directly inside the ignored QA artifact
 * directory. Reports and nested directories are intentionally left alone.
 * Running this at the beginning of a QA pass gives captures a bounded lifetime
 * without making the test harness depend on a separate cleanup process.
 */
async function cleanupOldScreenshotArtifacts(directory, maxAgeMs = 7 * DAY_MS, now = Date.now()) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError('maxAgeMs must be a non-negative finite number');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const cutoff = now - maxAgeMs;
  const result = { scanned: 0, removed: 0, retained: 0, removedFiles: [] };
  for (const entry of entries) {
    if (!entry.isFile() || !/\.png$/iu.test(entry.name)) continue;
    result.scanned += 1;
    const filePath = path.join(directory, entry.name);
    const metadata = await fs.stat(filePath);
    if (metadata.mtimeMs >= cutoff) {
      result.retained += 1;
      continue;
    }
    await fs.unlink(filePath);
    result.removed += 1;
    result.removedFiles.push(entry.name);
  }
  return result;
}

module.exports = { DAY_MS, cleanupOldScreenshotArtifacts };
