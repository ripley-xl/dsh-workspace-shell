import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeCatalog } from '../../../packages/shell/ssh-remote/src/host/runtime-catalog.js';
import { CONTROLLER_VERSION } from '../../../packages/shell/ssh-remote/controller/src/constants.js';

const linuxX64 = { platform: 'linux', arch: 'x64', libc: 'glibc' };

test('runtime recipe pins the local DSH version and the remote target', async () => {
  const catalog = new RuntimeCatalog({ controllerVersion: '9.9.9' });
  const recipe = await catalog.select({ version: '0.2.1-rc.5', target: linuxX64 });
  assert.equal(recipe.runtimeId, '0.2.1-rc.5-controller-9.9.9-linux-x64-glibc');
  assert.equal(recipe.dshVersion, '0.2.1-rc.5');
  assert.equal(recipe.buildId, 'npm:0.2.1-rc.5');
  assert.equal(recipe.installMode, 'npm');
  assert.deepEqual(recipe.target, linuxX64);
  assert.deepEqual(await catalog.list(), []);
});

test('runtime recipe carries the current controller version by default', async () => {
  const recipe = await new RuntimeCatalog().select({ version: '0.2.1-rc.5', target: linuxX64 });
  assert.equal(recipe.controllerVersion, CONTROLLER_VERSION);
  assert.equal(recipe.runtimeId, `0.2.1-rc.5-controller-${CONTROLLER_VERSION}-linux-x64-glibc`);
});

test('runtime recipe rejects a missing or malformed local DSH version', async () => {
  const catalog = new RuntimeCatalog();
  await assert.rejects(catalog.select({ version: undefined, target: linuxX64 }), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
  await assert.rejects(catalog.select({ version: 'not a version', target: linuxX64 }), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
});

test('runtime recipe rejects an unsupported remote target', async () => {
  const catalog = new RuntimeCatalog();
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'freebsd', arch: 'x64', libc: 'none' } }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'ia32', libc: 'glibc' } }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
  await assert.rejects(catalog.select({ version: '1.0.0', target: undefined }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
});

test('runtime recipe supports macOS targets', async () => {
  const recipe = await new RuntimeCatalog({ controllerVersion: '9.9.9' }).select({ version: '1.0.0', target: { platform: 'darwin', arch: 'arm64', libc: 'none' } });
  assert.equal(recipe.runtimeId, '1.0.0-controller-9.9.9-darwin-arm64-none');
});
