import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeCatalog } from '../../../packages/shell/ssh-remote/src/host/runtime-catalog.js';
import { probeRemoteTarget } from '../../../packages/shell/ssh-remote/src/host/target-probe.js';

test('runtime recipe selects the probed Darwin target', async () => {
  const recipe = await new RuntimeCatalog({ controllerVersion: '9.9.9' }).select({
    version: '1.0.0',
    target: { platform: 'darwin', arch: 'arm64', libc: 'none' },
  });
  assert.equal(recipe.runtimeId, '1.0.0-controller-9.9.9-darwin-arm64-none');
  assert.equal(recipe.installMode, 'npm');
});

test('runtime recipe rejects an unsupported remote platform', async () => {
  await assert.rejects(
    new RuntimeCatalog().select({ version: '1.0.0', target: { platform: 'freebsd', arch: 'x64', libc: 'none' } }),
    (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED',
  );
});

test('target probe supports Darwin without invoking ldd', async () => {
  const channel = {
    async exec(request) {
      if (request.command === 'ldd') throw new Error('ldd must not run on Darwin');
      return { code: 0, stdout: request.args[0] === '-s' ? 'Darwin\n' : 'arm64\n', stderr: '' };
    },
  };
  assert.deepEqual(await probeRemoteTarget(channel), { platform: 'darwin', arch: 'arm64', libc: 'none' });
});

test('target probe rejects an unknown Linux libc instead of guessing', async () => {
  const channel = {
    async exec(request) {
      if (request.command === 'uname') return { code: 0, stdout: request.args[0] === '-s' ? 'Linux\n' : 'x86_64\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unknown libc' };
    },
  };
  await assert.rejects(probeRemoteTarget(channel), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
});
