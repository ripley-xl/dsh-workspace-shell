import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createProfileUpgradeService, isDesktopCli, parseIgnoredBuilds, patchPnpmCommand,
} from '../../../packages/shell/src/host/profile-upgrade.js';

const TEMP_PREFIX = path.join(os.tmpdir(), 'dsh-profile-upgrade-');
const NPM = '/usr/local/bin/npm';
const DSH = '/usr/local/bin/global-dsh';
const PNPM = '/usr/local/bin/pnpm11';
const FIXED_NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const STAMP = '2026-11-09T12-00-00-000Z';

const HEADER = '# Your patch layer for this dsh profile\n# keep this header\n\n';

function processHandle({ stdout = '', exitCode = 0 } = {}) {
  const done = Promise.resolve({ exitCode, signal: null });
  const stream = Readable.from(stdout ? [stdout] : []);
  return {
    stdout: stream,
    stderr: Readable.from([]),
    done,
    terminate() { stream.push(null); },
    async waitForExit() { await done; return true; },
  };
}

function fakeSubprocess(options = {}) {
  const state = {
    calls: { resolve: [], spawn: [] },
    dumpCount: 0,
    npmCalls: [],
    pnpmCalls: [],
    npmExit: options.npmExit ?? 0,
    pnpmExit: options.pnpmExit ?? 0,
    dumpExit: options.dumpExit ?? 0,
    dumpText: options.dumpText ?? '- id: ui-settings\n- id: plugin-manager\n',
    dumpFailure: options.dumpFailure ?? null,
    resolvedDsh: options.resolvedDsh ?? DSH,
    pnpmStdout: options.pnpmStdout ?? '',
  };
  const subprocess = {
    async resolveExecutable(command) {
      state.calls.resolve.push(command);
      if (command === 'npm') return NPM;
      if (command === 'dsh') return state.resolvedDsh;
      return command;
    },
    spawn(spec) {
      state.calls.spawn.push(spec);
      const command = spec.argv[0];
      if (command === NPM) {
        state.npmCalls.push(spec.argv);
        const exitCode = typeof state.npmExit === 'function' ? state.npmExit(state.npmCalls.length) : state.npmExit;
        return processHandle({ exitCode });
      }
      if (command === PNPM) {
        state.pnpmCalls.push({ argv: spec.argv, cwd: spec.cwd });
        const exitCode = typeof state.pnpmExit === 'function' ? state.pnpmExit(state.pnpmCalls.length) : state.pnpmExit;
        const stdout = typeof state.pnpmStdout === 'function' ? state.pnpmStdout(state.pnpmCalls.length) : state.pnpmStdout;
        return processHandle({ stdout, exitCode });
      }
      if (spec.argv.includes('--dump-config')) {
        state.dumpCount += 1;
        const fail = typeof state.dumpFailure === 'function' ? state.dumpFailure(state.dumpCount) : state.dumpFailure === true;
        return processHandle({ stdout: fail ? '' : state.dumpText, exitCode: fail ? 1 : state.dumpExit });
      }
      return processHandle();
    },
  };
  return { subprocess, state };
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

const WEB_PATCH = [
  HEADER,
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    enabled: false',
  '- id: plugin-manager',
  '  name: "@deepseek-ai/dsh-plugin-manager"',
  '  config:',
  `    pnpmCommand: ${PNPM}`,
  '',
].join('\n');

const DESKTOP_PATCH = [
  HEADER,
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    enabled: true',
  '- id: plugin-manager',
  '  name: "@deepseek-ai/dsh-plugin-manager"',
  '  config:',
  '    pnpmCommand: /Users/someone/.dsh/bin/pnpm11',
  '- id: disabled-only',
  '  disabled: true',
  '- id: not-in-combine',
  '  name: "dsh-desktop-only"',
  '  config:',
  '    x: 1',
  '',
].join('\n');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(TEMP_PREFIX);
  const home = path.join(root, 'home');
  const webDir = path.join(home, 'profiles', 'web');
  const desktopDir = path.join(home, 'profiles', 'desktop');
  const lock = options.lock ?? 'lockfile: original\n';
  await writeJson(path.join(webDir, 'package.json'), {
    name: 'web',
    private: true,
    dependencies: options.webDependencies ?? {
      'dsh-context': '0.1.0',
      'dsh-workspace-shell': 'file:../shell.tgz',
      '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.5',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'], patchReload: 'live' } },
  });
  await fs.writeFile(path.join(webDir, 'cordis.patch.yml'), options.webPatch ?? WEB_PATCH);
  await fs.writeFile(path.join(webDir, 'pnpm-lock.yaml'), lock);
  if (options.desktop !== false) {
    await writeJson(path.join(desktopDir, 'package.json'), {
      name: 'desktop',
      dependencies: {
        'dsh-context': '0.1.0',
        'dsh-extra': '2.0.0',
        'dsh-workspace-shell': 'file:../desktop-shell.tgz',
        'dsh-pet': '0.4.7',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-extra', 'dsh-pet'] } },
    });
    await fs.writeFile(path.join(desktopDir, 'cordis.patch.yml'), DESKTOP_PATCH);
    await fs.writeFile(path.join(desktopDir, 'pnpm-lock.yaml'), 'desktop lock\n');
  }
  const { subprocess, state: fake } = fakeSubprocess(options.subprocess);
  const latestDshVersion = options.latestDshVersion ?? '0.2.2-rc.1';
  const latest = options.latest ?? {
    '@deepseek-ai/dsh': latestDshVersion,
    'dsh-context': '0.2.0',
    'dsh-extra': '2.0.0',
    '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.1',
  };
  const service = createProfileUpgradeService({
    subprocess,
    profileContext: { name: 'web', home, dir: webDir, cwd: root },
    latestVersions: { async latest(name) { return latest[name] ?? null; } },
    graceMs: 5,
    installTimeoutMs: 2_000,
    dumpTimeoutMs: 2_000,
    now: () => FIXED_NOW,
  });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, home, webDir, desktopDir, service, subprocess, fake, latest };
}

async function waitForState(service, target, { attempts = 500 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const value = service.state(target);
    if (value && value.phase !== 'running') return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the upgrade operation.');
}

async function originalFiles(fixtureValue) {
  return {
    manifest: JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8')),
    patch: await fs.readFile(path.join(fixtureValue.webDir, 'cordis.patch.yml'), 'utf8'),
    lock: await fs.readFile(path.join(fixtureValue.webDir, 'pnpm-lock.yaml'), 'utf8'),
  };
}

test('isDesktopCli recognizes the app-owned CLI paths and nothing else', () => {
  assert.equal(isDesktopCli('/usr/local/bin/dsh'), true);
  assert.equal(isDesktopCli('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'), true);
  assert.equal(isDesktopCli('/opt/homebrew/bin/dsh'), false);
  assert.equal(isDesktopCli('/usr/local/bin/global-dsh'), false);
  assert.equal(isDesktopCli('/Users/me/Applications/DeepSeek Harness.app/dsh'), true);
  assert.equal(isDesktopCli(''), false);
  assert.equal(isDesktopCli(null), false);
});

test('patchPnpmCommand reads only the plugin-manager entry, quoted or plain', () => {
  assert.equal(patchPnpmCommand(WEB_PATCH), PNPM);
  assert.equal(patchPnpmCommand(`${HEADER}- id: plugin-manager\n  config:\n    pnpmCommand: "/opt/pnpm11"\n`), '/opt/pnpm11');
  assert.equal(patchPnpmCommand(`${HEADER}- id: plugin-manager\n  config:\n    other: 1\n`), null);
  assert.equal(patchPnpmCommand(`${HEADER}- id: plugin-manager\n  config:\n    pnpmCommand: relative/pnpm\n`), null);
  assert.equal(patchPnpmCommand(null), null);
});

test('successful align upgrades DSH, dependencies, bundles and patch config with a 0600 backup', async (t) => {
  const fixtureValue = await fixture(t);
  const started = fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  assert.deepEqual(started, { started: true, upgrade: { phase: 'running', step: 'backup' } });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.deepEqual(final, { phase: 'done', step: 'validate' });

  const manifest = JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    'dsh-context': '0.2.0',
    'dsh-workspace-shell': 'file:../shell.tgz',
    '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.1',
    'dsh-extra': '2.0.0',
  }, 'excluded shell is untouched, web-only packages stay and desktop additions append');
  assert.deepEqual(manifest.dsh, { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base', 'dsh-extra'], patchReload: 'live' } });
  assert.equal(manifest.name, 'web');

  const patch = await fs.readFile(path.join(fixtureValue.webDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.startsWith(HEADER), 'the patch header is preserved');
  assert.match(patch, /- id: ui-settings\n {2}name: "@deepseek-ai\/dsh-client-ui-settings"\n {2}config:\n {4}enabled: true/u);
  assert.match(patch, new RegExp(`- id: plugin-manager[\\s\\S]*pnpmCommand: ${PNPM.replace('/', '\\/')}`, 'u'));
  assert.doesNotMatch(patch, /disabled-only|not-in-combine|desktop-only/u);

  assert.deepEqual(fixtureValue.fake.npmCalls, [[NPM, 'install', '-g', '@deepseek-ai/dsh@0.2.2-rc.1']]);
  assert.deepEqual(fixtureValue.fake.pnpmCalls.map((call) => call.argv), [[PNPM, 'install']]);
  assert.equal(fixtureValue.fake.pnpmCalls[0].cwd, await fs.realpath(fixtureValue.webDir));
  assert.equal(fixtureValue.fake.calls.resolve.filter((command) => command === 'dsh').length, 3,
    'the CLI is classified once and dump-config runs for planning and validation');
  assert.equal(fixtureValue.fake.calls.spawn.some((spec) => spec.argv.includes('--dump-config')), true);

  const backupRoot = path.join(fixtureValue.webDir, '.host-upgrades');
  assert.deepEqual(await fs.readdir(backupRoot), [STAMP]);
  const backupDir = path.join(backupRoot, STAMP);
  assert.equal((await fs.stat(backupRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(backupDir)).mode & 0o777, 0o700);
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    assert.equal((await fs.stat(path.join(backupDir, name))).mode & 0o777, 0o600, `${name} backup is private`);
  }
  assert.equal(await fs.readFile(path.join(backupDir, 'pnpm-lock.yaml'), 'utf8'), 'lockfile: original\n');
  assert.equal(fixtureValue.service.state({ profileId: 'web' }), null, 'terminal state is consumed once');
});

test('parseIgnoredBuilds keeps bounded safe package identities only', () => {
  assert.deepEqual(parseIgnoredBuilds('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: a@1.0.0, @s/b@2.0.0'), ['a@1.0.0', '@s/b@2.0.0']);
  assert.deepEqual(parseIgnoredBuilds('Ignored build scripts: bad name!, ok@1'), ['ok@1']);
  assert.deepEqual(parseIgnoredBuilds('nothing to approve'), []);
  assert.deepEqual(parseIgnoredBuilds(null), []);
});

test('ignored build-script approvals complete the upgrade instead of rolling it back', async (t) => {
  const fixtureValue = await fixture(t, {
    subprocess: {
      pnpmExit: 1,
      pnpmStdout: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @jackwener/opencli@2.0.0\n\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.\n',
    },
  });
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.deepEqual(final, { phase: 'done', step: 'validate', ignoredBuilds: ['@jackwener/opencli@2.0.0'] });
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['dsh-extra'], '2.0.0', 'the dependency rewrite is kept');
  assert.equal(fixtureValue.fake.dumpCount, 2, 'dump-config still validates the installed tree');
});

test('profiles without a desktop profile only move registry dependencies to latest', async (t) => {
  const fixtureValue = await fixture(t, { desktop: false, latestDshVersion: '0.2.1-rc.5' });
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.deepEqual(final, { phase: 'done', step: 'validate' });
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    'dsh-context': '0.2.0',
    'dsh-workspace-shell': 'file:../shell.tgz',
    '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.5',
  }, 'official web-only packages never leave their version without a DSH target');
  assert.equal(await fs.readFile(path.join(fixtureValue.webDir, 'cordis.patch.yml'), 'utf8'), WEB_PATCH);
  assert.equal(fixtureValue.fake.npmCalls.length, 0);
  assert.deepEqual(fixtureValue.fake.pnpmCalls.map((call) => call.argv), [[PNPM, 'install']]);
});

test('nothing to do completes without rewriting files or running npm/pnpm', async (t) => {
  const settledPatch = [
    HEADER,
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    '  disabled: true',
    '',
  ].join('\n');
  const webManifest = {
    name: 'web',
    dependencies: { '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.1' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'] } },
  };
  const fixtureValue = await fixture(t, { desktop: false, latestDshVersion: '0.2.1-rc.5', webPatch: settledPatch });
  // Replace the fixture manifest with one that already matches its target.
  await writeJson(path.join(fixtureValue.webDir, 'package.json'), webManifest);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.deepEqual(final, { phase: 'done', step: 'backup', noop: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8')), webManifest);
  assert.equal(fixtureValue.fake.npmCalls.length, 0);
  assert.equal(fixtureValue.fake.pnpmCalls.length, 0);
});

test('pnpm install failure restores every file and re-installs the backup lockfile', async (t) => {
  const fixtureValue = await fixture(t, { subprocess: { pnpmExit: (call) => call === 1 ? 1 : 0 } });
  const before = await originalFiles(fixtureValue);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.phase, 'failed');
  assert.equal(final.error, 'UPGRADE_INSTALL_FAILED');
  const after = await originalFiles(fixtureValue);
  assert.deepEqual(after, before);
  const argv = fixtureValue.fake.pnpmCalls.map((call) => call.argv);
  assert.deepEqual(argv, [[PNPM, 'install'], [PNPM, 'install', '--frozen-lockfile']]);
});

test('validation failure restores files and reports the safe code', async (t) => {
  const fixtureValue = await fixture(t, { subprocess: { dumpFailure: (count) => count === 2 } });
  const before = await originalFiles(fixtureValue);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.phase, 'failed');
  assert.equal(final.error, 'UPGRADE_VALIDATION_FAILED');
  assert.deepEqual(await originalFiles(fixtureValue), before);
  assert.deepEqual(fixtureValue.fake.pnpmCalls.map((call) => call.argv), [[PNPM, 'install'], [PNPM, 'install', '--frozen-lockfile']]);
});

test('backup failure aborts before any write or command', async (t) => {
  const fixtureValue = await fixture(t);
  await fs.writeFile(path.join(fixtureValue.webDir, '.host-upgrades'), 'not a directory');
  const before = await originalFiles(fixtureValue);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.error, 'UPGRADE_BACKUP_FAILED');
  assert.deepEqual(await originalFiles(fixtureValue), before);
  assert.equal(fixtureValue.fake.npmCalls.length, 0);
  assert.equal(fixtureValue.fake.pnpmCalls.length, 0);
});

test('npm install failure aborts without touching profile files', async (t) => {
  const fixtureValue = await fixture(t, { subprocess: { npmExit: 1 } });
  const before = await originalFiles(fixtureValue);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.error, 'UPGRADE_NPM_FAILED');
  assert.deepEqual(await originalFiles(fixtureValue), before);
  assert.equal(fixtureValue.fake.pnpmCalls.length, 0);
});

test('stopHost failure aborts before writing and never runs pnpm', async (t) => {
  const fixtureValue = await fixture(t);
  const before = await originalFiles(fixtureValue);
  fixtureValue.service.start({
    profileId: 'web', runtimeId: 'runtime-1', dshVersion: '0.2.1-rc.5',
    stopHost: async () => { throw new Error('secret stop failure'); },
  });
  const final = await waitForState(fixtureValue.service, { profileId: 'web', runtimeId: 'runtime-1' });
  assert.equal(final.error, 'UPGRADE_RUNTIME_UNAVAILABLE');
  assert.deepEqual(await originalFiles(fixtureValue), before);
  assert.equal(fixtureValue.fake.pnpmCalls.length, 0);
});

test('a second start for the same profile reports UPGRADE_BUSY', async (t) => {
  const fixtureValue = await fixture(t);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  assert.throws(() => fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' }), (error) => {
    assert.equal(error.code, 'UPGRADE_BUSY');
    assert.equal(error.safe, true);
    return true;
  });
  await waitForState(fixtureValue.service, { profileId: 'web' });
});

test('non-web profiles are rejected before any command', async (t) => {
  const fixtureValue = await fixture(t, { webDependencies: { 'dsh-recall-plugin': '1.0.0' } });
  const manifestPath = path.join(fixtureValue.webDir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dsh.profile.bundles = ['dsh-workspace-shell'];
  await writeJson(manifestPath, manifest);
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.error, 'UPGRADE_UNSUPPORTED_PROFILE');
  assert.equal(fixtureValue.fake.calls.spawn.length, 0);
});

test('catalog probe reports latest versions and pending alignment without writing', async (t) => {
  const fixtureValue = await fixture(t);
  const before = await originalFiles(fixtureValue);
  const value = await fixtureValue.service.check({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  assert.equal(value.latestDshVersion, '0.2.2-rc.1');
  assert.equal(value.alignPending, true);
  assert.deepEqual(await originalFiles(fixtureValue), before);
  assert.equal(fixtureValue.fake.pnpmCalls.length, 0);
  assert.equal(fixtureValue.fake.npmCalls.length, 0);

  const upToDate = await fixture(t, { latestDshVersion: '0.2.1-rc.5', desktop: false });
  await writeJson(path.join(upToDate.webDir, 'package.json'), {
    name: 'web',
    dependencies: { 'dsh-context': '0.2.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'] } },
  });
  await fs.writeFile(path.join(upToDate.webDir, 'cordis.patch.yml'), WEB_PATCH);
  const settled = await upToDate.service.check({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  assert.equal(settled.alignPending, false);
});

test('profile lookup rejects traversal and symlinked profile directories', async (t) => {
  const fixtureValue = await fixture(t);
  assert.throws(() => fixtureValue.service.start({ profileId: '../web', dshVersion: '0.2.1-rc.5' }), (error) => {
    assert.equal(error.code, 'UPGRADE_UNSUPPORTED_PROFILE');
    return true;
  });
  const moved = path.join(fixtureValue.home, 'profiles', 'moved');
  await fs.rename(fixtureValue.webDir, moved);
  const outside = path.join(fixtureValue.root, 'outside');
  await writeJson(path.join(outside, 'package.json'), {
    name: 'web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  });
  await fs.symlink(outside, fixtureValue.webDir, 'dir');
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.error, 'UPGRADE_PROFILE_UNAVAILABLE');
  assert.equal(fixtureValue.fake.calls.spawn.length, 0, 'no command runs for an escaping profile');
});

test('the Desktop app CLI keeps its version and never runs a global DSH install', async (t) => {
  const fixtureValue = await fixture(t, { subprocess: { resolvedDsh: '/usr/local/bin/dsh' } });
  const checked = await fixtureValue.service.check({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  assert.equal(checked.dshUpgradeAllowed, false);
  assert.equal(checked.latestDshVersion, '0.2.2-rc.1');
  fixtureValue.service.start({ profileId: 'web', dshVersion: '0.2.1-rc.5' });
  const final = await waitForState(fixtureValue.service, { profileId: 'web' });
  assert.equal(final.phase, 'done');
  assert.equal(fixtureValue.fake.npmCalls.length, 0, 'the app CLI version follows the app, not npm');
  assert.deepEqual(fixtureValue.fake.pnpmCalls.map((call) => call.argv), [[PNPM, 'install']], 'plugin alignment still runs');
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureValue.webDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['dsh-context'], '0.2.0', 'dependencies still align to latest');
});
