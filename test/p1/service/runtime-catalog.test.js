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

test('runtime catalog selects the exact version, build and remote target', async (t) => {
  const { directory, add } = await fixture(t);
  await add('1.0.0');
  await add('1.0.0', 'arm64');
  await add('0.9.0');
  const catalog = new RuntimeCatalog({ directory });
  const selected = await catalog.select({ version: '1.0.0', buildId: 'build-1', target: { platform: 'linux', arch: 'arm64', libc: 'glibc' } });
  assert.equal(selected.runtimeId, '1.0.0-linux-arm64-glibc');
  await assert.rejects(catalog.select({ version: '2.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
  await assert.rejects(catalog.select({ version: '1.0.0', buildId: 'other-build', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
});

test('runtime catalog rejects a missing target and ambiguous exact matches', async (t) => {
  const { directory, add } = await fixture(t);
  await add('1.0.0');
  const catalog = new RuntimeCatalog({ directory });
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'arm64', libc: 'musl' } }), (error) => error.code === 'REMOTE_PLATFORM_UNSUPPORTED');
  await add('1.0.0', 'x64', 'different-build');
  await fs.copyFile(path.join(directory, 'dsh-ssh-remote-1.0.0-linux-x64-glibc.tar.gz.json'), path.join(directory, 'duplicate.tar.gz.json'));
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
});

test('runtime catalog verifies archive size and digest before upload', async (t) => {
  const { directory, add } = await fixture(t);
  const metadata = await add('1.0.0');
  const catalog = new RuntimeCatalog({ directory });
  await fs.writeFile(path.join(directory, metadata.filename), 'tampered');
  await assert.rejects(catalog.select({ version: '1.0.0', target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }), (error) => ['REMOTE_INSTALL_FAILED', 'REMOTE_SHA256_MISMATCH'].includes(error.code));
});
