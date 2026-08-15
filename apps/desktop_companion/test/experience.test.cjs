'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const renderer = readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const main = readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Bridge shell exposes only its essential status and pairing actions', () => {
  assert.match(html, />Connect Tethoq to this PC</);
  assert.match(html, />Pair a phone</);
  assert.doesNotMatch(html, /Local bridge</);
  assert.match(html, /class="companion-version"/);
  assert.match(html, /Runs quietly in your tray/);
  assert.doesNotMatch(html, /Continue with Google|Continue with email|Create account/);
  assert.doesNotMatch(html, /Provider check|Codex|OpenCode|Grok Build/);
});

test('frameless controls are custom, accessible, and revealed by hover or focus', () => {
  assert.match(main, /frame:\s*false/);
  assert.match(html, /id="window-minimize"[^>]*aria-label="Minimize"/);
  assert.match(html, /id="window-close"[^>]*aria-label="Close to tray"/);
  assert.match(css, /\.window-controls\s*{[^}]*opacity:\s*0/);
  assert.match(css, /\.titlebar:hover \.window-controls,[\s\S]*\.window-controls:focus-within\s*{\s*opacity:\s*1/);
  assert.match(renderer, /hideWindow\(\)/);
  assert.match(renderer, /minimizeWindow\(\)/);
});

test('pairing stays inline and keeps security language concise', () => {
  assert.match(html, /id="pairing-qr"/);
  assert.match(html, />Scan with Tethoq</);
  assert.match(html, />Generate a new code</);
  assert.match(html, /Nothing connects until you scan it/);
  assert.doesNotMatch(html, /Open pairing QR|Preview a successful scan/i);
});

test('hidden UI stops animation and renderer polling is event driven', () => {
  assert.match(css, /body\.page-hidden \.spinner\s*{\s*animation-play-state:\s*paused/);
  assert.match(renderer, /visibilitychange/);
  assert.match(renderer, /if \(document\.hidden\) clearPairingTimer\(\)/);
  assert.doesNotMatch(renderer, /getPairingStatus\(\)[\s\S]{0,100}setInterval/);
  assert.match(renderer, /onPairingState/);
});

test('Windows packaging uses the dedicated Bridge connector icon', () => {
  assert.equal(packageJson.build.win.icon, 'src/assets/tethoq-bridge.ico');
  assert.equal(packageJson.build.productName, 'Tethoq Bridge');
  assert.match(packageJson.build.win.artifactName, /Tethoq-Bridge/);
});

test('runtime window and tray use the canonical Tethoq mark', () => {
  assert.match(main, /const canonicalIconPath = path\.join\(assetsDirectory, 'tethoq-icon\.png'\);/);
  assert.match(main, /const windowIconPath = canonicalIconPath;/);
  assert.match(main, /const resolvedTrayIconPath = canonicalIconPath;/);
});
