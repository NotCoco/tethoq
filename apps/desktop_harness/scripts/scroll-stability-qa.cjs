'use strict';

/**
 * Migrated scroll-stability QA entry point.
 *
 * The synthetic #scroll-stability renderer branch that this script used to
 * drive was removed from src/renderer/src/bridge.ts. The same coverage now
 * lives in the isolated fake model harness: scripts/fake-model-qa.cjs plays
 * the deterministic queue stream through the real renderer path and checks
 * reader-owned viewport stability, reasoning expansion anchors, and
 * task-switch preservation.
 */

const path = require('node:path');
const { app } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const artifactDirectory = path.resolve(appRoot, '..', '..', 'local-artifacts', 'scroll-stability-qa');

process.argv = [...process.argv, '--only=queue-steer-and-viewport-stability', artifactDirectory];

const { runFakeModelQa } = require('./fake-model-qa.cjs');

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await runFakeModelQa();
    console.log('Scroll stability QA passed (fake model driver)');
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    app.exit(exitCode);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
