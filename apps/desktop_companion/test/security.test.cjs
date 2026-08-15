'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  SECURE_WEB_PREFERENCES,
  normalizePreviewState,
} = require('../src/security.cjs');

const root = path.resolve(__dirname, '..');

test('BrowserWindow preferences isolate and sandbox the renderer', () => {
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(SECURE_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(SECURE_WEB_PREFERENCES.sandbox, true);
  assert.equal(SECURE_WEB_PREFERENCES.webSecurity, true);
  assert.equal(SECURE_WEB_PREFERENCES.allowRunningInsecureContent, false);
});

test('preview state accepts only deterministic states', () => {
  assert.equal(normalizePreviewState('connected'), 'connected');
  assert.equal(normalizePreviewState('first-run'), 'first-run');
  assert.equal(normalizePreviewState('anything-else'), 'first-run');
  assert.equal(normalizePreviewState(undefined), 'first-run');
});

test('renderer has a strict CSP and no inline executable code', () => {
  const html = readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son\w+\s*=/i);
});

test('preload exposes only allowlisted companion methods', () => {
  const preload = readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8');
  const channels = preload.match(/tethoq:[a-z-]+/g) ?? [];
  assert.deepEqual([...new Set(channels)].sort(), [
    'tethoq:abort-pairing-start',
    'tethoq:cancel-pairing',
    'tethoq:complete-preview',
    'tethoq:get-app-meta',
    'tethoq:get-pairing-status',
    'tethoq:get-preview-state',
    'tethoq:pairing-progress',
    'tethoq:pairing-state',
    'tethoq:reset-preview',
    'tethoq:set-window-mode',
    'tethoq:start-pairing',
    'tethoq:window-hide',
    'tethoq:window-minimize',
  ]);
});

test('Bridge uses dedicated PNG, tray, and multi-resolution Windows assets', () => {
  const png = readFileSync(path.join(root, 'src', 'assets', 'tethoq-bridge.png'));
  const tray = readFileSync(path.join(root, 'src', 'assets', 'tethoq-bridge-tray.png'));
  const tray2x = readFileSync(path.join(root, 'src', 'assets', 'tethoq-bridge-tray@2x.png'));
  const ico = readFileSync(path.join(root, 'src', 'assets', 'tethoq-bridge.ico'));
  for (const asset of [png, tray, tray2x]) {
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
});
