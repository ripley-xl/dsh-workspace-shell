import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dshInstall = process.env.DSH_INSTALL_DIR;
if (dshInstall === undefined) throw new Error('Set DSH_INSTALL_DIR to the installed @deepseek-ai/dsh package directory');
const { loadProfileDirectory, composeEntries } = await import(pathToFileURL(dshInstall + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').href);

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-workspace-bundle.mjs RELEASE_DIRECTORY');
const release = resolve(process.argv[2]);
const home = await mkdtemp('/tmp/wsh-package-');
try {
  const manifest = JSON.parse(await readFile(join(release, 'package/package.json'), 'utf8'));
  const filename = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz';
  const directory = join(home, 'package');
  await mkdir(directory);
  execFileSync('tar', ['-xzf', join(release, filename), '-C', directory, '--strip-components=1']);
  for (const relative of ['client.js', 'index.js', 'cordis.patch.yml', 'session-host/index.js', 'session-host/submissions.js', 'ssh-remote/index.js', 'ssh-remote/src/host/index.js', 'ssh-remote/controller/src/cli.js', 'ssh-remote/controller/src/install.js', 'ssh-remote/plugins/status/index.js', 'src/host/session-hosts.js', 'src/host/session-views.js']) {
    assert.deepEqual(await readFile(join(directory, relative)), await readFile(join(release, 'package', relative)), relative);
  }
  const profile = join(home, 'profile');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(directory, join(profile, 'node_modules/dsh-workspace-shell'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-workspace-shell'] } } }));
  const loaded = loadProfileDirectory('workspace-test', profile, dshInstall + '/package.json');
  assert.deepEqual(loaded.skippedBundles, []);
  const entries = composeEntries(loaded.layers.map((layer) => layer.patches));
  assert.deepEqual(entries.map((entry) => entry.id), ['workspace-shell']);
  assert.equal(entries.some((entry) => entry.disabled), false);
  assert.equal(entries[0].group, undefined);
  assert.equal(entries[0].config, undefined);
  console.log('Release tar contents and the single bundled plugin entry verified');
} finally {
  await rm(home, { recursive: true, force: true });
}
