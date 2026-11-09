import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeCatalog } from '../../../packages/manager/src/host/runtime-catalog.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const add = async (version, arch = 'x64', buildId = 'build-1') => {
    const runtimeId = `${version}-linux-${arch}-glibc`;
    const filename = `dsh-ssh-remote-${runtimeId}.tar.gz`;
    const content = `runtime-${runtimeId}`;
    await fs.writeFile(path.join(directory, filename), content);
    const metadata = {
      filename,
      runtimeId,
      dshVersion: version,
      buildId,
      nodeVersion: 'v24.0.0',
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    };
    await fs.writeFile(path.join(directory, `${filename}.json`), JSON.stringify(metadata));
    return metadata;
  };
  return { directory, add };
}

test('runtime catalog prefers the requested version and falls back to the bundled target runtime', async (t) => {
  const { directory, add } = await fixture(t);
  await add('1.0.0');
  await add('1.0.0', 'arm64');
  await add('0.9.0');
  const catalog = new RuntimeCatalog({ directory });
  const selected = await catalog.select({ version: '1.0.0', buildId: 'build-1', target: { platform: 'linux', arch: 'arm64', libc: 'glibc' } });
  assert.equal(selected.runtimeId, '1.0.0-linux-arm64-glibc');
  // The local DSH version is only a preference; a bundled runtime still answers.
  const fallback = await catalog.select({ version: '2.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } });
  assert.equal(fallback.runtimeId, '1.0.0-linux-x64-glibc');
  await assert.rejects(catalog.select({ version: '1.0.0', buildId: 'other-build', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => error.code === 'REMOTE_INSTALL_FAILED');
});

test('runtime catalog rejects a missing target and tolerates duplicate metadata', async (t) => {
  const { directory, add } = await fixture(t);
  await add('1.0.0');
  const catalog = new RuntimeCatalog({ directory });
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'arm64', libc: 'musl' } }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
  await add('1.0.0', 'x64', 'different-build');
  await fs.copyFile(path.join(directory, 'dsh-ssh-remote-1.0.0-linux-x64-glibc.tar.gz.json'), path.join(directory, 'duplicate.tar.gz.json'));
  const selected = await catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } });
  assert.equal(selected.runtimeId, '1.0.0-linux-x64-glibc');
});

test('runtime catalog newest picks the highest SemVer runtime for one target', async (t) => {
  const { directory, add } = await fixture(t);
  await add('0.2.1-rc.5');
  await add('0.2.2-rc.1');
  await add('0.2.2');
  await add('0.2.10');
  await add('0.10.0', 'arm64');
  const catalog = new RuntimeCatalog({ directory });
  const target = { platform: 'linux', arch: 'x64', libc: 'glibc' };
  const newest = await catalog.newest({ target });
  assert.equal(newest.dshVersion, '0.2.10');
  assert.equal(newest.runtimeId, '0.2.10-linux-x64-glibc');
  assert.equal((await catalog.newest({ target: { platform: 'linux', arch: 'arm64', libc: 'glibc' } })).dshVersion, '0.10.0');
  // No matching artifact is an empty answer, not a thrown error.
  assert.equal(await catalog.newest({ target: { platform: 'darwin', arch: 'x64', libc: 'none' } }), null);
  await assert.rejects(catalog.newest({ target: { platform: 'windows', arch: 'x64', libc: 'none' } }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
});

test('runtime catalog newest treats a prerelease as older than its release', async (t) => {
  const { directory, add } = await fixture(t);
  await add('1.0.0-rc.2');
  await add('1.0.0-rc.10');
  const catalog = new RuntimeCatalog({ directory });
  const target = { platform: 'linux', arch: 'x64', libc: 'glibc' };
  assert.equal((await catalog.newest({ target })).dshVersion, '1.0.0-rc.10');
  await add('1.0.0');
  assert.equal((await catalog.newest({ target })).dshVersion, '1.0.0');
});

test('runtime catalog verifies archive size and digest before upload', async (t) => {
  const { directory, add } = await fixture(t);
  const metadata = await add('1.0.0');
  const catalog = new RuntimeCatalog({ directory });
  await fs.writeFile(path.join(directory, metadata.filename), 'tampered');
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => ['REMOTE_INSTALL_FAILED', 'REMOTE_SHA256_MISMATCH'].includes(error.code));
});
