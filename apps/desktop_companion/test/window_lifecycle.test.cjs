'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  WINDOW_MODES,
  fitWindowBounds,
  normalizeWindowMode,
} = require('../src/window_lifecycle.cjs');

const main = readFileSync(path.resolve(__dirname, '..', 'src', 'main.cjs'), 'utf8');

test('window modes stay compact and clamp to the active display work area', () => {
  assert.deepEqual(WINDOW_MODES.summary, { width: 432, height: 226 });
  assert.deepEqual(WINDOW_MODES.pairing, { width: 432, height: 518 });
  assert.equal(normalizeWindowMode('unknown'), 'summary');
  assert.deepEqual(fitWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 'summary'), {
    x: 1472,
    y: 798,
    width: 432,
    height: 226,
  });
  const constrained = fitWindowBounds({ x: -1280, y: 0, width: 360, height: 420 }, 'pairing');
  assert.deepEqual(constrained, { x: -1276, y: 16, width: 340, height: 388 });
});

test('companion is single-instance, tray-first, and releases hidden renderers', () => {
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /process\.argv\.includes\('--background'\)/);
  assert.match(main, /process\.argv\.includes\('--tethoq-bridge'\)/);
  assert.match(main, /if \(!startsInBackground\) createWindow\(\)/);
  assert.match(main, /if \(!mainWindow \|\| !rendererReady\) return/);
  assert.match(main, /const HIDDEN_RENDERER_RETENTION_MS = 30_000/);
  assert.match(main, /mainWindow\.destroy\(\)/);
  assert.match(main, /mainWindow\.setSkipTaskbar\(true\)/);
  assert.match(main, /app\.on\('window-all-closed', \(\) => \{\}\)/);
});

test('GPU is disabled and Chromium background throttling stays enabled', () => {
  assert.match(main, /app\.disableHardwareAcceleration\(\)/);
  assert.match(main, /backgroundThrottling:\s*true/);
});

test('only explicit Bridge quit shuts down the persistent pairing engine', () => {
  assert.match(main, /label:\s*'Quit Tethoq Bridge'/);
  assert.match(main, /pairing\.shutdown\(\)/);
  assert.doesNotMatch(main, /hideMainWindow[\s\S]{0,180}pairing\.shutdown/);
});
