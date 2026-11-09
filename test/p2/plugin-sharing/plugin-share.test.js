import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalPluginSnapshot,
  shareLocalPlugins,
  syncOfficialPlugins,
  uploadLocalPluginSnapshot,
} from '../../../packages/manager/src/host/plugin-share.js';

function localBundle(overrides = {}) {
  return {
    name: '@official/example',
    official: true,
    optional: true,
    enabled: true,
    installed: true,
    removable: true,
    availability: 'profile',
    version: '1.2.3',
    source: 'npm',
    installTarget: { spec: '@official/example@1.2.3', version: '1.2.3' },
    meta: { title: { en: 'Example', zh: '示例' }, description: 'Example plugin', icon: './icon.svg' },
    pendingBuilds: ['example-build'],
    ...overrides,
  };
}

function clientWith(handler) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      return handler(path, body, calls.length);
    },
  };
}

test('local snapshot uses only public bundle fields required by the remote page', () => {
  const snapshot = createLocalPluginSnapshot([localBundle({
    browserUrl: 'http://127.0.0.1/?tkn=local-secret',
    credentials: { API_KEY: 'local-secret' },
    secrets: [{ path: ['apiKey'] }],
    packageResult: { logPath: '/Users/alice/.dsh/plugin.log', output: 'secret output' },
    rows: [{ entryId: 'private-entry' }],
    overrides: ['local-patch'],
    installTarget: { spec: '@official/example@1.2.3', version: '1.2.3', packageDir: '/Users/alice/.dsh/example' },
  })]);
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    bundles: [{
      name: '@official/example',
      spec: '@official/example@1.2.3',
      enabled: true,
      official: true,
      optional: true,
      version: '1.2.3',
      source: 'npm',
      meta: { title: { en: 'Example', zh: '示例' }, description: 'Example plugin', icon: './icon.svg' },
      availability: 'profile',
      installed: true,
      removable: true,
      pendingBuilds: ['example-build'],
    }],
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['local-secret', 'browserUrl', 'credentials', 'secrets', 'packageResult', 'rows', 'overrides', 'packageDir']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('snapshot creation removes local paths and falls back to a non-path spec', () => {
  const snapshot = createLocalPluginSnapshot([localBundle({
    name: '@local/example',
    official: false,
    installTarget: { spec: '/Users/alice/code/example', version: '1.2.3' },
    source: 'file:///Users/alice/code/example',
    meta: { title: 'Example', description: 'Located at /Users/alice/code/example', icon: '/Users/alice/code/example/icon.svg' },
  })]);
  const [plugin] = snapshot.bundles;
  assert.equal(plugin.spec, '@local/example@1.2.3');
  assert.equal('source' in plugin, false);
  assert.deepEqual(plugin.meta, { title: 'Example' });
  assert.equal(JSON.stringify(snapshot).includes('/Users/alice'), false);
});

test('snapshot creation removes nested credential-like metadata and token URLs', () => {
  const snapshot = createLocalPluginSnapshot([localBundle({
    source: 'https://example.com/registry?token=local-secret',
    meta: { title: { credentials: 'local-secret' }, description: 'Safe description' },
  })]);
  assert.deepEqual(snapshot.bundles[0].meta, { description: 'Safe description' });
  assert.equal('source' in snapshot.bundles[0], false);
  assert.equal(JSON.stringify(snapshot).includes('local-secret'), false);
});

test('snapshot creation enforces count and size before upload', async () => {
  const bundles = Array.from({ length: 257 }, (_, index) => localBundle({ name: `@official/example-${index}` }));
  assert.throws(() => createLocalPluginSnapshot(bundles), /at most 256/u);
  const large = Array.from({ length: 30 }, (_, index) => localBundle({
    name: `@official/example-${index}`,
    meta: { description: 'x'.repeat(1800) },
  }));
  assert.throws(() => createLocalPluginSnapshot(large), /exceeds 49152 bytes/u);

  let called = false;
  const client = { async post() { called = true; } };
  await assert.rejects(uploadLocalPluginSnapshot(client, bundles), /at most 256/u);
  assert.equal(called, false);
});

test('upload and official sync use RemoteClient-compatible post methods', async () => {
  const snapshot = createLocalPluginSnapshot([localBundle()]);
  const client = clientWith(async (path) => path.endsWith('local-inventory')
    ? { ok: true, snapshot }
    : { ok: true, restartRequired: false, items: [] });
  const uploaded = await uploadLocalPluginSnapshot(client, snapshot);
  assert.equal(uploaded.ok, true);
  const official = await syncOfficialPlugins(client);
  assert.equal(official.ok, true);
  assert.deepEqual(client.calls, [
    { path: '/api/ssh-remote/plugins/local-inventory', body: { snapshot } },
    { path: '/api/ssh-remote/plugins/official', body: {} },
  ]);
});

test('shareLocalPlugins uploads before synchronizing official enablement', async () => {
  const client = clientWith(async (path, _body, count) => ({
    ok: true,
    snapshot: createLocalPluginSnapshot([localBundle()]),
    official: undefined,
    restartRequired: count === 2,
    items: [],
  }));
  const report = await shareLocalPlugins(client, [localBundle()]);
  assert.equal(report.ok, true);
  assert.deepEqual(client.calls.map((call) => call.path), [
    '/api/ssh-remote/plugins/local-inventory',
    '/api/ssh-remote/plugins/official',
  ]);
  assert.equal(report.official.restartRequired, true);
  assert.equal(JSON.stringify(report).includes('local-secret'), false);
});

test('shareLocalPlugins surfaces partial official failure and stops after upload failure', async () => {
  const partialClient = clientWith(async (path) => path.endsWith('official')
    ? { ok: false, items: [{ name: '@official/example', ok: false, error: 'write failed' }] }
    : { ok: true });
  const partial = await shareLocalPlugins(partialClient, [localBundle()]);
  assert.equal(partial.ok, false);
  assert.equal(partial.official.items[0].ok, false);

  const failedClient = clientWith(async () => { throw new Error('inventory rejected'); });
  await assert.rejects(shareLocalPlugins(failedClient, [localBundle()]), /inventory rejected/u);
  assert.equal(failedClient.calls.length, 1);
});
