import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeCatalog } from '../../../packages/manager/src/host/runtime-catalog.js';
import { probeRemoteTarget } from '../../../packages/manager/src/host/target-probe.js';

test('runtime catalog selects Darwin and skips unrelated unsupported platforms', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-runtime-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtimeId = '1.0.0-darwin-arm64-none';
  const filename = `dsh-ssh-remote-${runtimeId}.tar.gz`;
  const bytes = Buffer.from('darwin-fixture');
  await fs.writeFile(path.join(directory, filename), bytes);
  const metadata = {
    filename, runtimeId, dshVersion: '1.0.0', buildId: 'build-1',
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  };
  await fs.writeFile(path.join(directory, `${filename}.json`), JSON.stringify(metadata));
  await fs.writeFile(path.join(directory, 'dsh-ssh-remote-1.0.0-freebsd-x64-none.tar.gz.json'), JSON.stringify({
    ...metadata,
    filename: 'dsh-ssh-remote-1.0.0-freebsd-x64-none.tar.gz',
    runtimeId: '1.0.0-freebsd-x64-none',
  }));

  const catalog = new RuntimeCatalog({ directory });
  const selected = await catalog.select({
    version: '1.0.0', buildId: 'build-1', target: { platform: 'darwin', arch: 'arm64', libc: 'none' },
  });
  assert.equal(selected.runtimeId, runtimeId);
  assert.equal((await catalog.list()).length, 1);
});

test('runtime catalog prefers a controller-versioned artifact over a legacy runtime', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-runtime-controller-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = { platform: 'linux', arch: 'x64', libc: 'glibc' };
  for (const controllerVersion of [null, '0.2.0']) {
    const runtimeId = controllerVersion ? `1.0.0-controller-${controllerVersion}-linux-x64-glibc` : '1.0.0-linux-x64-glibc';
    const filename = `dsh-ssh-remote-${runtimeId}.tar.gz`;
    const bytes = Buffer.from(runtimeId);
    await fs.writeFile(path.join(directory, filename), bytes);
    await fs.writeFile(path.join(directory, `${filename}.json`), JSON.stringify({
      filename, runtimeId, dshVersion: '1.0.0', buildId: 'build-1',
      ...(controllerVersion ? { controllerVersion } : {}),
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    }));
  }
  const selected = await new RuntimeCatalog({ directory }).select({ version: '1.0.0', buildId: 'build-1', target });
  assert.equal(selected.runtimeId, '1.0.0-controller-0.2.0-linux-x64-glibc');
  assert.equal(selected.controllerVersion, '0.2.0');
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
