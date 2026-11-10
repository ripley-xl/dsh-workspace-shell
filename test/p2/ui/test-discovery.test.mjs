import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { discoverNamedTests } from '../../../scripts/test.mjs';

const testRoot = fileURLToPath(new URL('../../', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('default regression discovery includes nested named tests but never standalone real-runtime runners', async () => {
  const files = await discoverNamedTests(testRoot);
  const names = files.map((file) => path.relative(testRoot, file));
  assert.ok(names.includes('p2/ui/ssh-workspace-extension.test.mjs'));
  assert.ok(names.includes('p2/ui/shell-ssh-launcher.test.mjs'));
  assert.equal(files.length, new Set(files).size);
  assert.deepEqual(files, [...files].sort());
  assert.ok(names.every((name) => /\.test\.[cm]?js$/u.test(name)));
  for (const entry of ['p2/runtime/macos-smoke.mjs', 'p2/runtime/verify-http.mjs']) {
    assert.equal(names.includes(entry), false, `Standalone runner must stay explicit: ${entry}`);
  }
});

test('discovery skips hidden runtime trees, dependencies, fixtures, artifacts and symlink directories', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-test-discovery-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('ssh-test-discovery-'));
    await rm(target, { recursive: true, force: true });
  });
  const names = ['a.test.js', 'nested/b.test.mjs', '.runtime/hidden.test.js', 'node_modules/x/dependency.test.js', 'fixtures/fixture.test.js', 'artifacts/built.test.js', 'run.mjs'];
  for (const name of names) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'export {};\n');
  }
  await symlink(path.join(directory, 'nested'), path.join(directory, 'linked'), 'dir');
  assert.deepEqual((await discoverNamedTests(directory)).map((file) => path.relative(directory, file)), ['a.test.js', 'nested/b.test.mjs']);
});

test('guest Client matches the authored sources', () => {
  const result = spawnSync(process.execPath, ['scripts/build-guest-client.mjs', '--check'], {
    cwd: projectRoot, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('distributed SSH component Client matches the authored modules', () => {
  const result = spawnSync(process.execPath, ['scripts/build-manager-client.mjs', '--check'], {
    cwd: projectRoot, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
