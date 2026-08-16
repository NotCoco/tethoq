'use strict';

const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..', '..');

test('Bridge installer metadata is per-user, branded, and preserves app data', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.appId, 'app.tethoq.bridge');
  assert.equal(pkg.build.productName, 'Tethoq Bridge');
  assert.equal(pkg.build.copyright, 'Copyright (c) 2026 Tethoq');
  assert.equal(pkg.build.win.icon, 'src/assets/tethoq-bridge.ico');
  assert.equal(pkg.build.win.legalTrademarks, 'Tethoq');
  assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.menuCategory, 'Tethoq');
  assert.equal(pkg.build.nsis.uninstallDisplayName, 'Tethoq Bridge ${version}');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.installerIcon, 'src/assets/tethoq-bridge.ico');
  assert.equal(pkg.build.nsis.uninstallerIcon, 'src/assets/tethoq-bridge.ico');
  assert.equal(pkg.build.nsis.installerHeader, 'build/installer/installer-header.bmp');
  assert.equal(pkg.build.nsis.installerSidebar, 'build/installer/installer-sidebar.bmp');
  assert.equal(pkg.build.nsis.uninstallerSidebar, 'build/installer/uninstaller-sidebar.bmp');
  assert.ok(pkg.build.extraResources.some((entry) => entry.from === '../../LICENSE' && entry.to === 'legal/TETHOQ-LICENSE.txt'));
  assert.ok(pkg.build.extraResources.some((entry) => entry.from === '../../THIRD_PARTY_NOTICES.md' && entry.to === 'legal/THIRD_PARTY_NOTICES.md'));
});

test('installer artwork has deterministic NSIS dimensions and 24-bit BMP encoding', () => {
  const expected = new Map([
    ['installer-header.bmp', [150, 57]],
    ['installer-sidebar.bmp', [164, 314]],
    ['uninstaller-sidebar.bmp', [164, 314]],
  ]);
  for (const [name, [width, height]] of expected) {
    const bitmap = readFileSync(path.join(root, 'build', 'installer', name));
    assert.equal(bitmap.subarray(0, 2).toString('ascii'), 'BM');
    assert.equal(bitmap.readInt32LE(18), width);
    assert.equal(bitmap.readInt32LE(22), height);
    assert.equal(bitmap.readUInt16LE(28), 24);
  }
});

test('Bridge runtime stages every built-in adapter and provider tool asset', () => {
  const stageScript = readFileSync(path.join(repoRoot, 'scripts', 'release', 'stage-bridge-runtime.ps1'), 'utf8');
  const runtimePackages = stageScript.match(/\$runtimePackages = @\(([\s\S]*?)\r?\n\)/)?.[1] ?? '';

  for (const packageName of [
    'provider_contract',
    'provider_codex',
    'provider_direct',
    'provider_fake',
    'provider_grok',
    'provider_opencode',
    'provider_pi',
  ]) {
    assert.match(runtimePackages, new RegExp(`'${packageName}'`));
  }
  for (const acpPreset of ['provider_qwen', 'provider_goose', 'provider_kimi', 'provider_hermes', 'provider_cline', 'provider_copilot']) {
    assert.doesNotMatch(runtimePackages, new RegExp(`'${acpPreset}'`), `${acpPreset} must reuse the packaged provider_grok ACP adapter`);
  }

  assert.match(stageScript, /assets\\opencode\\uar_mesh\.txt/);
  assert.match(stageScript, /assets\\pi\\tethoq_tools\.txt/);
  assert.match(stageScript, /THIRD_PARTY_NOTICES\.md/);
  assert.match(stageScript, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.doesNotMatch(stageScript, /\bGet-FileHash\b/);
  assert.ok(existsSync(path.join(repoRoot, 'apps', 'agent_bridge', 'assets', 'opencode', 'uar_mesh.txt')));
  assert.ok(existsSync(path.join(repoRoot, 'apps', 'agent_bridge', 'assets', 'pi', 'tethoq_tools.txt')));

  const includedProviders = ['codex', 'opencode', 'grok', 'pi', 'omp', 'qwen', 'goose', 'kimi', 'hermes', 'cline', 'copilot', 'direct'];
  for (const providerId of includedProviders) assert.match(stageScript, new RegExp(`'${providerId}'`));
});
