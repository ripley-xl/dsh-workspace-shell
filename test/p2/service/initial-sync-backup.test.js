import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from '../../p1/service/helpers.mjs';

const BACKUP = { id: 'backup-1', path: '/remote/.dsh/backups/backup-1', createdAt: '2026-01-01T00:00:00Z', profile: 'web', bytes: 1234 };

test('first default sync backs up remote user config and plugin state before writing', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const events = [];
  fixture.service.localBundles = async () => [{ name: '@deepseek-ai/optional', official: true, optional: true, enabled: true, version: '1.0.0' }];
  fixture.service.createRemoteBackup = async () => {
    events.push('backup');
    return BACKUP;
  };
  fixture.service.shareLocalPlugins = async () => {
    events.push('official');
    return { ok: true, snapshot: { schemaVersion: 1, bundles: [] }, official: { ok: true, restartRequired: false, items: [] } };
  };
  const open = fixture.service.openRemoteHost;
  fixture.service.openRemoteHost = async (options) => {
    const opened = await open(options);
    opened.host.client.post = async (path) => {
      if (path === '/api/ssh-remote/settings/describe') {
        return { ok: true, descriptors: [{ ns: 'ui-theme', revision: 8, value: { preference: 'light', fontSize: 14 }, user: { preference: 'light' } }] };
      }
      if (path === '/api/ssh-remote/plugins/list') {
        return { ok: true, bundles: [{ name: '@deepseek-ai/optional', official: true, optional: true, enabled: false, version: '1.0.0' }] };
      }
      if (path === '/api/ssh-remote/credentials/describe') return { ok: true, credentials: {} };
      if (path === '/api/ssh-remote/settings/update') events.push('settings');
      return { ok: true };
    };
    return opened;
  };
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { allSupported: true } });
  const connected = await fixture.service.connect(record.id);
  assert.equal(connected.sync.ok, true);
  assert.deepEqual(connected.sync.backup, BACKUP);
  assert.equal(connected.sync.requiresMerge, true);
  assert.deepEqual(connected.sync.mergeReasons, ['remote-user-settings', 'remote-plugin-state']);
  assert.ok(events.indexOf('backup') < events.indexOf('settings'));
  assert.ok(events.indexOf('backup') < events.indexOf('official'));
  assert.equal(JSON.stringify(connected.sync).includes('secret'), false);
});

test('subsequent connections do not replay settings, credentials, backup or official enablement', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  let backups = 0;
  let shares = 0;
  fixture.service.createRemoteBackup = async () => { backups += 1; return BACKUP; };
  fixture.service.shareLocalPlugins = async () => {
    shares += 1;
    return { ok: true, snapshot: { schemaVersion: 1, bundles: [] }, official: { ok: true, restartRequired: false, items: [] } };
  };
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { allSupported: true } });
  await fixture.service.connect(record.id);
  const calls = fixture.state.calls.length;
  await fixture.service.connect(record.id);
  assert.equal(fixture.state.calls.length, calls);
  await fixture.service.disconnect(record.id);
  await fixture.service.connect(record.id);
  assert.equal(fixture.state.calls.length, calls);
  assert.equal(backups, 0);
  assert.equal(shares, 1);
});

test('schema-discovered credentials are described before only configured refs are resolved', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  fixture.descriptors.splice(0, fixture.descriptors.length, {
    ns: 'include:llm-deepseek',
    schema: { properties: { apiKeyEnv: { default: 'DEEPSEEK_API_KEY', 'x-cordis': { role: 'credential-ref' } }, baseURL: {} } },
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
    user: { baseURL: 'https://api.deepseek.com' },
  }, {
    ns: 'include:opencode-go',
    schema: { properties: { accounts: { items: { properties: { apiKeyEnv: { 'x-cordis': { role: 'credential-ref' } } } } } } },
    value: { accounts: [{ apiKeyEnv: 'OPENCODE_ALT_KEY' }] },
    user: {},
  });
  const described = [];
  fixture.service.credentials.describe = async (ref) => {
    described.push(ref);
    return { configured: ref === 'DEEPSEEK_API_KEY', writable: true };
  };
  const open = fixture.service.openRemoteHost;
  let remoteRefs;
  fixture.service.openRemoteHost = async (options) => {
    const opened = await open(options);
    const post = opened.host.client.post.bind(opened.host.client);
    opened.host.client.post = async (path, body) => {
      if (path === '/api/ssh-remote/credentials/describe') {
        remoteRefs = body.refs;
        return { ok: true, credentials: Object.fromEntries(body.refs.map((ref) => [ref, { configured: true, writable: true }])) };
      }
      if (path === '/api/ssh-remote/settings/describe') return { ok: true, descriptors: [] };
      if (path === '/api/ssh-remote/plugins/list') return { ok: true, bundles: [] };
      return post(path, body);
    };
    return opened;
  };
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { allSupported: true, credentialRefs: ['LEGACY_KEY'] } });
  await fixture.service.connect(record.id);
  assert.deepEqual(remoteRefs, ['DEEPSEEK_API_KEY', 'OPENCODE_ALT_KEY']);
  assert.deepEqual(fixture.credentialCalls, ['DEEPSEEK_API_KEY']);
  assert.ok(described.includes('OPENCODE_ALT_KEY'));
  assert.equal(fixture.credentialCalls.includes('LEGACY_KEY'), false);
});
