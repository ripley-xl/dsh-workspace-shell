import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProfileDirectory, composeEntries } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-workspace-bundle.mjs RELEASE_DIRECTORY');
const release = resolve(process.argv[2]);
const home = await mkdtemp('/tmp/wsh-package-');
try {
  for (const name of ['shell', 'manager']) {
    const manifest = JSON.parse(await readFile(join(release, name, 'package.json'), 'utf8'));
    const filename = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz';
    const directory = join(home, name);
    await mkdir(directory);
    execFileSync('tar', ['-xzf', join(release, filename), '-C', directory, '--strip-components=1']);
    for (const relative of name === 'shell' ? ['client.js', 'session-host/index.js', 'session-host/submissions.js', 'src/host/session-hosts.js', 'src/host/session-views.js'] : ['client.js']) {
      assert.deepEqual(await readFile(join(directory, relative)), await readFile(join(release, name, relative)), relative);
    }
  }
  const profile = join(home, 'profile');
  await mkdir(join(profile, 'node_modules/@local'), { recursive: true });
  await symlink(join(home, 'shell'), join(profile, 'node_modules/@local/dsh-workspace-shell'));
  await symlink(join(home, 'manager'), join(profile, 'node_modules/@local/dsh-ssh-remote'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@local/dsh-workspace-shell'] } } }));
  const loaded = loadProfileDirectory('workspace-test', profile, '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json');
  assert.deepEqual(loaded.skippedBundles, []);
  const entries = composeEntries(loaded.layers.map((layer) => layer.patches));
  assert.deepEqual(entries.map((entry) => entry.id), ['workspace-shell']);
  assert.equal(entries.some((entry) => entry.disabled), false);
  assert.equal(entries[0].group, true);
  assert.deepEqual(entries[0].config.map((entry) => entry.id), ['ssh-remote']);
  assert.equal(entries[0].config[0].disabled, undefined);
  console.log('Release tar contents, mandatory core and default-enabled nested SSH verified');
} finally {
  await rm(home, { recursive: true, force: true });
}
