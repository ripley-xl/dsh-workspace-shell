import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../../../packages/status/src/host/index.js';

async function fixture(t, { prepareDocument = true, configuration, plugins } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-ssh-remote-backup-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const routes = new Map();
  const calls = [];
  const rows = configuration ?? [{
    entry: { options: { id: 'model', name: '@example/model' }, fiber: { cyclic: true } },
    inherited: { theme: 'dark' },
    override: { apiKey: 'remote-secret', model: 'example' },
  }];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    configEditor: {
      documentPath: join(profileDir, 'cordis.patch.yml'),
      configuration() { calls.push('configuration'); return rows; },
      entries() {
        calls.push('entries');
        return [{ options: { id: 'model', name: '@example/model' }, fiber: {} }];
      },
      ...prepareDocument ? {
        async prepareDocument() {
          calls.push('prepareDocument');
          return { path: join(profileDir, 'cordis.patch.yml') };
        },
      } : {},
    },
    pluginManager: {
      async listBundles() {
        calls.push('listBundles');
        return plugins ?? [{ name: '@example/plugin', version: '1.0.0', enabled: true, official: false, optional: true }];
      },
    },
    settings: { describe: () => [], async update() {} },
    credentials: {
      async describe() { return { configured: true, writable: true }; },
      async set() { throw new Error('not expected'); },
      async resolve() { throw new Error('Backup must not resolve credentials.'); },
    },
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'backup-test', dshVersion: '1.0.0' });
  return { routes, calls, profileDir, ctx };
}

async function post(routes, value = {}, raw) {
  const path = '/api/ssh-remote/sync/backup';
  const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST', body: raw ?? JSON.stringify(value),
  }));
  return { response, value: await response.json() };
}

test('backup writes configuration and plugin state into a private remote file', async (t) => {
  const { routes, calls, profileDir } = await fixture(t);
  const { response, value } = await post(routes);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(value), ['ok', 'backup']);
  assert.equal(value.ok, true);
  assert.deepEqual(Object.keys(value.backup).sort(), ['bytes', 'createdAt', 'id', 'path', 'profile'].sort());
  assert.equal(value.backup.profile, 'web');
  assert.ok(Number.isFinite(Date.parse(value.backup.createdAt)));
  assert.match(value.backup.id, /^.+-.+[0-9a-f-]{36}$/u);
  assert.equal(value.backup.path.startsWith(join(profileDir, '.ssh-remote-backups')), true);
  assert.equal(JSON.stringify(value).includes('remote-secret'), false);
  assert.deepEqual(calls, ['configuration', 'entries', 'listBundles', 'prepareDocument']);

  const backupStat = await stat(value.backup.path);
  assert.equal(backupStat.isFile(), true);
  assert.equal(backupStat.mode & 0o777, 0o600);
  assert.equal(backupStat.size, value.backup.bytes);
  const directoryStat = await stat(join(profileDir, '.ssh-remote-backups'));
  assert.equal(directoryStat.mode & 0o777, 0o700);

  const content = JSON.parse(await readFile(value.backup.path, 'utf8'));
  assert.equal(content.schemaVersion, 1);
  assert.equal(content.id, value.backup.id);
  assert.equal(content.createdAt, value.backup.createdAt);
  assert.deepEqual(content.entries, [{ id: 'model', name: '@example/model' }]);
  assert.deepEqual(content.configuration, [{
    entry: { id: 'model', name: '@example/model' },
    inherited: { theme: 'dark' },
    override: { apiKey: 'remote-secret', model: 'example' },
  }]);
  assert.equal(content.plugins[0].name, '@example/plugin');
  assert.equal(content.entries[0].fiber, undefined);
  assert.equal([...routes.keys()].some((path) => /backup\/(content|read|download)/u.test(path)), false);
});

test('backup supports the installed configEditor documentPath fallback', async (t) => {
  const { routes, calls, profileDir } = await fixture(t, { prepareDocument: false });
  const { response, value } = await post(routes, { profile: 'web' });
  assert.equal(response.status, 200);
  assert.equal(value.ok, true);
  assert.equal(value.backup.path.startsWith(join(profileDir, '.ssh-remote-backups')), true);
  assert.equal(calls.includes('prepareDocument'), false);
  assert.equal((await stat(value.backup.path)).mode & 0o777, 0o600);
});

test('backup rejects oversized content before creating a directory', async (t) => {
  const { routes, profileDir } = await fixture(t, {
    configuration: [{ entry: { options: { id: 'large' } }, inherited: {}, override: { value: 'x'.repeat(4 * 1024 * 1024) } }],
  });
  const { response, value } = await post(routes);
  assert.equal(response.status, 400);
  assert.equal(value.ok, false);
  assert.match(value.error, /exceeds 4194304 bytes/u);
  assert.equal('backup' in value, false);
  assert.deepEqual(await readdir(profileDir), []);
});

test('backup request body is bounded and accepts only the web profile', async (t) => {
  const { routes, calls, profileDir } = await fixture(t);
  const invalid = await post(routes, { readSecrets: true });
  assert.equal(invalid.response.status, 400);
  const wrongProfile = await post(routes, { profile: 'local' });
  assert.equal(wrongProfile.response.status, 400);
  const oversized = await post(routes, null, `{"padding":"${'x'.repeat(65 * 1024)}"}`);
  assert.equal(oversized.response.status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(profileDir), []);
});

test('filesystem failure returns an error without backup metadata', async (t) => {
  const { routes, profileDir } = await fixture(t);
  await writeFile(join(profileDir, '.ssh-remote-backups'), 'not a directory', { mode: 0o600 });
  const { response, value } = await post(routes);
  assert.equal(response.status, 400);
  assert.equal(value.ok, false);
  assert.equal('backup' in value, false);
  assert.equal((await stat(join(profileDir, '.ssh-remote-backups'))).isFile(), true);
});

test('serialization failure does not expose configuration values', async (t) => {
  const cyclic = {};
  cyclic.self = cyclic;
  const { routes, profileDir } = await fixture(t, {
    configuration: [{ entry: { options: { id: 'cyclic' } }, inherited: {}, override: cyclic }],
  });
  const { response, value } = await post(routes);
  assert.equal(response.status, 400);
  assert.deepEqual(value, { ok: false, error: 'The remote configuration cannot be serialized for backup.' });
  assert.deepEqual(await readdir(profileDir), []);
});
