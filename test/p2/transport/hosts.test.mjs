import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listConfiguredSshHosts } from '../../../packages/manager/src/host/ssh/hosts.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-host-discovery-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const homeDir = path.join(directory, 'home');
  const configFile = path.join(directory, 'config', 'config');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  return {
    configFile,
    directory,
    homeDir,
    async write(relative, content) {
      const file = path.isAbsolute(relative) ? relative : path.join(directory, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      return file;
    },
  };
}

function options(fixture) {
  return { configFile: fixture.configFile, homeDir: fixture.homeDir };
}

test('a missing ~/.ssh/config returns an empty host list', async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await listConfiguredSshHosts(options(context)), []);
});

test('returns literal aliases in declaration order with source and display fields', async (t) => {
  const context = await fixture(t);
  await context.write('config/config', `
User global-user
Host beta alpha *.invalid !negated
  HostName "first.example#1"
  User first-user
  Port=2222
  IdentityFile /must/not/be/read
Host alpha
  HostName later.example
  User later-user
  Port 2200
Host gamma
  User gamma-user
`);
  const hosts = await listConfiguredSshHosts(options(context));
  assert.deepEqual(hosts, [
    {
      alias: 'beta',
      source: context.configFile,
      hostName: 'first.example#1',
      user: 'global-user',
      port: 2222,
    },
    {
      alias: 'alpha',
      source: context.configFile,
      hostName: 'first.example#1',
      user: 'global-user',
      port: 2222,
    },
    {
      alias: 'gamma',
      source: context.configFile,
      user: 'global-user',
    },
  ]);
});

test('wildcard and negated blocks affect values without becoming aliases', async (t) => {
  const context = await fixture(t);
  await context.write('config/config', `
Host *.example
  User wildcard-user
Host * !blocked
  Port 2022
Host literal.example blocked
  HostName target.example
`);
  assert.deepEqual(await listConfiguredSshHosts(options(context)), [
    {
      alias: 'literal.example',
      source: context.configFile,
      hostName: 'target.example',
      user: 'wildcard-user',
      port: 2022,
    },
    {
      alias: 'blocked',
      source: context.configFile,
      hostName: 'target.example',
    },
  ]);
});

test('Include recursively expands relative, absolute, home and sorted glob paths', async (t) => {
  const context = await fixture(t);
  const absolute = await context.write('absolute.conf', 'Host absolute\n  User absolute-user\n');
  await context.write('home/home.conf', 'Host home-alias\n  Port 2023\n');
  await context.write('config/sub/nested/two.conf', `Include ${absolute}\nHost nested\n`);
  await context.write('config/sub/one.conf', 'Include nested/two.conf\nHost relative\n');
  await context.write('config/conf.d/20.conf', 'Host twenty\n');
  await context.write('config/conf.d/10.conf', 'Host ten\nHost alpha\n  HostName first.example\n');
  await context.write('config/dir with spaces/space.conf', 'Host space\n');
  await context.write('config/config', `
Include conf.d/*.conf sub/one.conf ~/home.conf "dir with spaces/*.conf"
Host alpha
  HostName ignored.example
Host final
`);
  const hosts = await listConfiguredSshHosts(options(context));
  assert.deepEqual(hosts.map(({ alias }) => alias), [
    'ten',
    'alpha',
    'twenty',
    'absolute',
    'nested',
    'relative',
    'home-alias',
    'space',
    'final',
  ]);
  assert.equal(hosts[1].hostName, 'first.example');
  assert.equal(hosts.find(({ alias }) => alias === 'absolute').source, absolute);
  assert.equal(hosts.find(({ alias }) => alias === 'home-alias').port, 2023);
});

test('Include is textual and preserves first-value-wins across nested files', async (t) => {
  const context = await fixture(t);
  await context.write('config/first.conf', `
Host alpha
  HostName first.example
  Port 2222
Host second
  User second-user
`);
  await context.write('config/second.conf', `
Host alpha
  HostName second.example
  User second-user
  Port 2200
`);
  await context.write('config/config', 'Include first.conf second.conf\nHost alpha\n  HostName third.example\n');
  const hosts = await listConfiguredSshHosts(options(context));
  assert.deepEqual(hosts.map(({ alias }) => alias), ['alpha', 'second']);
  assert.deepEqual(hosts[0], {
    alias: 'alpha',
    source: path.join(context.directory, 'config', 'first.conf'),
    hostName: 'first.example',
    user: 'second-user',
    port: 2222,
  });
});

test('duplicate aliases retain first spelling and order', async (t) => {
  const context = await fixture(t);
  await context.write('config/config', 'Host beta alpha\nHost ALPHA gamma\nHost beta\n');
  const hosts = await listConfiguredSshHosts(options(context));
  assert.deepEqual(hosts.map(({ alias }) => alias), ['beta', 'alpha', 'gamma']);
});

test('unmatched Include globs are ignored', async (t) => {
  const context = await fixture(t);
  await context.write('config/config', 'Include missing/*.conf\nHost alpha\n');
  assert.deepEqual((await listConfiguredSshHosts(options(context))).map(({ alias }) => alias), ['alpha']);
});

test('Include cycles fail closed without infinite recursion', async (t) => {
  const context = await fixture(t);
  await context.write('config/sub/a.conf', 'Include ../config\nHost unreachable\n');
  await context.write('config/config', 'Include sub/a.conf\nHost alpha\n');
  await assert.rejects(listConfiguredSshHosts(options(context)), (error) => {
    assert.equal(error.code, 'SSH_CONFIG_INVALID');
    assert.equal(error.details.reason, 'include_cycle');
    return true;
  });
});

for (const [name, expectedReason, override, content] of [
  ['file bytes', 'file_size', { maxFileBytes: 4 }, 'Host alpha\n'],
  ['file count', 'max_files', { maxFiles: 1 }, 'Include child.conf\nHost alpha\n'],
  ['include depth', 'max_depth', { maxDepth: 0 }, 'Include child.conf\nHost alpha\n'],
  ['host count', 'max_hosts', { maxHosts: 1 }, 'Host alpha beta\n'],
]) {
  test(`bounds ${name}`, async (t) => {
    const context = await fixture(t);
    await context.write('config/child.conf', 'Host child\n');
    await context.write('config/config', content);
    await assert.rejects(listConfiguredSshHosts({ ...options(context), ...override }), (error) => {
      assert.equal(error.code, 'SSH_CONFIG_INVALID');
      assert.equal(error.details.reason, expectedReason);
      return true;
    });
  });
}

test('bounds glob expansion count', async (t) => {
  const context = await fixture(t);
  await context.write('config/conf.d/a.conf', 'Host a\n');
  await context.write('config/conf.d/b.conf', 'Host b\n');
  await context.write('config/config', 'Include conf.d/*.conf\n');
  await assert.rejects(listConfiguredSshHosts({ ...options(context), maxGlobMatches: 1 }), {
    code: 'SSH_CONFIG_INVALID',
  });
});
