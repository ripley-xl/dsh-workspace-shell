import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { installRuntimeFromNpm } from '../../../packages/shell/ssh-remote/controller/src/install.js';
import { currentTarget, runtimeId } from '../../../packages/shell/ssh-remote/controller/src/platform.js';

const CONTROLLER_SOURCE = fileURLToPath(new URL('../../../packages/shell/ssh-remote/controller/', import.meta.url));
const DSH_VERSION = '0.2.1-rc.5';

const fakeNpm = `#!/bin/sh
set -eu
version="\${FAKE_DSH_VERSION:-0.2.1-rc.5}"
case "$PWD" in
  */app)
    mkdir -p node_modules/@deepseek-ai/dsh/lib node_modules/@deepseek-ai/dsh-web-frontend/dist
    printf '%s\\n' "{\\"name\\":\\"@deepseek-ai/dsh\\",\\"version\\":\\"$version\\"}" > node_modules/@deepseek-ai/dsh/package.json
    printf '%s\\n' "console.log('$version')" > node_modules/@deepseek-ai/dsh/lib/bin.js
    : > node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html
    ;;
esac
exit 0
`;

async function makeBin(t, { node = 'real', npm = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wsh-npm-bin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (node === 'real') {
    await writeFile(path.join(directory, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  } else if (node === 'old') {
    await writeFile(path.join(directory, 'node'), '#!/bin/sh\nprintf "v18.20.0\\n"\n', { mode: 0o755 });
  }
  if (npm) {
    const npmPath = path.join(directory, 'npm');
    await writeFile(npmPath, fakeNpm, { mode: 0o755 });
    await chmod(npmPath, 0o755);
  }
  return directory;
}

const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

async function withPath(directory, action) {
  const previous = process.env.PATH;
  process.env.PATH = directory + ':' + BASE_PATH;
  try {
    return await action();
  } finally {
    process.env.PATH = previous;
  }
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsh-npm-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('npm install writes an npm-mode runtime with the local DSH version', async (t) => {
  const bin = await makeBin(t);
  const root = await makeRoot(t);
  const result = await withPath(bin, () => installRuntimeFromNpm({
    root,
    dshVersion: DSH_VERSION,
    controllerSource: CONTROLLER_SOURCE,
    timeoutMs: 120_000,
  }));
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.path, path.join(root, 'servers', runtimeId(DSH_VERSION, await currentTarget())));
  const manifest = JSON.parse(await readFile(path.join(result.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.dshVersion, DSH_VERSION);
  assert.equal(manifest.buildId, `npm:${DSH_VERSION}`);
  assert.equal(manifest.installMode, 'npm');
  assert.match(manifest.nodeVersion, /^v\d+\./u);
  const receipt = JSON.parse(await readFile(path.join(result.path, 'install-receipt.json'), 'utf8'));
  assert.equal(receipt.installMode, 'npm');
  const wrapper = await readFile(path.join(result.path, 'bin', 'node'), 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\nexec "/u);
  const frontend = await readFile(path.join(result.path, 'app', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), 'utf8').catch(() => null);
  assert.equal(frontend, '');
  const again = await withPath(bin, () => installRuntimeFromNpm({ root, dshVersion: DSH_VERSION, controllerSource: CONTROLLER_SOURCE }));
  assert.equal(again.alreadyInstalled, true);
});

test('a remote without Node.js fails with an actionable code', async (t) => {
  const bin = await makeBin(t, { node: 'missing' });
  const root = await makeRoot(t);
  await withPath(bin, async () => {
    await assert.rejects(installRuntimeFromNpm({ root, dshVersion: DSH_VERSION, controllerSource: CONTROLLER_SOURCE }), (error) => error.code === 'REMOTE_NODE_MISSING' && /Node\.js/u.test(error.message));
  });
});

test('an old remote Node.js fails before installing anything', async (t) => {
  const bin = await makeBin(t, { node: 'old' });
  const root = await makeRoot(t);
  await withPath(bin, async () => {
    await assert.rejects(installRuntimeFromNpm({ root, dshVersion: DSH_VERSION, controllerSource: CONTROLLER_SOURCE }), (error) => error.code === 'REMOTE_NODE_UNSUPPORTED');
  });
});

test('a remote without npm fails with an actionable code', async (t) => {
  const bin = await makeBin(t, { node: 'real', npm: false });
  const root = await makeRoot(t);
  await withPath(bin, async () => {
    await assert.rejects(installRuntimeFromNpm({ root, dshVersion: DSH_VERSION, controllerSource: CONTROLLER_SOURCE }), (error) => error.code === 'REMOTE_NPM_MISSING');
  });
});
