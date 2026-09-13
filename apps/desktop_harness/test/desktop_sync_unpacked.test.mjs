import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const source = await readFile(new URL('../scripts/sync-unpacked.cjs', import.meta.url), 'utf8');

for (const scenario of ['success', 'build-failed', 'pack-failed', 'swap-verification-failed']) {
  test(`local app sync preserves a usable package: ${scenario}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'tethoq-sync-test-'));
    t.after(async () => {
      assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(root, { recursive: true, force: true });
    });
    const harness = path.join(root, 'apps', 'desktop_harness');
    const old = path.join(root, 'old-app');
    const resources = path.join(harness, 'release', 'win-unpacked', 'resources');
    const archive = path.join(resources, 'app.asar');
    const put = async (base, relative, value) => {
      const target = path.join(base, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value);
    };
    await put(old, 'out/main/index.js', 'old main');
    await put(old, 'out/renderer/stale.js', 'old renderer');
    await put(old, 'node_modules/example/index.js', 'retained dependency');
    await put(old, 'package.json', '{}');
    await mkdir(resources, { recursive: true });
    await asar.createPackage(old, archive);
    const original = await readFile(archive);
    for (const relative of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) await put(harness, relative, `new ${relative}`);
    await put(harness, 'package.json', '{"main":"out/main/index.js"}');
    await put(path.join(root, 'apps/agent_bridge/assets'), 'opencode/uar_mesh.txt', 'OpenCode tools');
    await put(path.join(root, 'apps/agent_bridge/assets'), 'opencode/tethoq_images.txt', 'OpenCode image policy');
    await put(path.join(root, 'apps/agent_bridge/assets'), 'pi/tethoq_tools.txt', 'Pi tools');
    const calls = [];
    let failedVerification = false;
    const scriptAsar = { ...asar,
      createPackageWithOptions: (...args) => scenario === 'pack-failed' ? Promise.reject(new Error('fixture pack failure')) : asar.createPackageWithOptions(...args),
      extractFile: (file, relative) => {
        if (scenario === 'swap-verification-failed' && file === archive && !failedVerification) {
          failedVerification = true;
          return Buffer.from('bad replacement');
        }
        return asar.extractFile(file, relative);
      },
    };
    const context = {
      __dirname: path.join(harness, 'scripts'),
      require: (name) => {
        if (name === './stop-unpacked.cjs') return { running: () => [123], stopTethoq: () => {
          assert.deepEqual(readFileSync(archive), original, 'the live package must survive until staging is verified');
          calls.push('stop'); return true;
        } };
        if (name === 'node:child_process') return { spawnSync: (exe, args) => {
          if (exe === 'npm') { assert.deepEqual(Array.from(args), ['run', 'build:bundle']); calls.push('build'); return { status: scenario === 'build-failed' ? 1 : 0 }; }
          assert.equal(exe, process.execPath);
          assert.equal(args[1], '--synced');
          calls.push('launch'); return { status: 0 };
        } };
        if (name === path.join(harness, 'node_modules/@electron/asar')) return scriptAsar;
        return require(name);
      },
      process: { argv: ['node', 'sync', '--relaunch-if-running', ...(scenario === 'build-failed' ? [] : ['--no-build'])], execPath: process.execPath,
        stdout: { write() {} }, exit: (status) => { throw new Error(`exit ${status}`); } },
      console: { error() {} },
    };
    if (scenario === 'success') {
      await vm.runInNewContext(source, context);
      asar.uncache(archive);
      assert.equal(asar.extractFile(archive, path.join('out/main/index.js')).toString(), 'new out/main/index.js');
      assert.equal(asar.extractFile(archive, path.join('node_modules/example/index.js')).toString(), 'retained dependency');
      assert.ok(!asar.listPackage(archive).some(file => file.endsWith('stale.js')));
      assert.deepEqual(await readFile(`${archive}.previous`), original);
      assert.deepEqual(calls, ['stop', 'launch']);
    } else {
      await assert.rejects(async () => await vm.runInNewContext(source, context), /exit 1/);
      assert.deepEqual(await readFile(archive), original, 'failure must leave or restore the old app');
      assert.deepEqual(calls, scenario === 'build-failed' ? ['build'] : scenario === 'pack-failed' ? [] : ['stop', 'launch']);
    }
  });
}
