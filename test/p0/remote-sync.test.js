import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRemote, syncRemoteCredentials, syncRemotePlugins } from '../../packages/manager/src/host/remote-sync.js';

function clientWith(routes) {
  return {
    async post(path, body) {
      const handler = routes[path];
      if (!handler) throw new Error(`unexpected route: ${path}`);
      return handler(body);
    },
  };
}

test('plugin sync preserves build approval and restart state', async () => {
  const client = clientWith({
    '/api/ssh-remote/plugins/install': async (body) => {
      assert.equal(body.spec, '@local/example@1.0.0');
      assert.deepEqual(body.approvedBuilds, ['allowed-package']);
      return { ok: true, result: { application: 'restart-required', pendingBuilds: [] } };
    },
  });
  const report = await syncRemotePlugins(client, [{ spec: '@local/example@1.0.0', approvedBuilds: ['allowed-package'] }]);
  assert.equal(report.restartRequired, true);
  assert.equal(report.ok, true);
});

test('credential sync reports refs without including secret values', async () => {
  const client = clientWith({
    '/api/ssh-remote/credentials/set': async (body) => {
      assert.equal(body.value, 'secret-api-key');
      return { ok: true };
    },
  });
  const report = await syncRemoteCredentials(client, [{ ref: 'TEST_KEY', value: 'secret-api-key' }]);
  assert.deepEqual(report, { ok: true, items: [{ ref: 'TEST_KEY', ok: true }] });
  assert.equal(JSON.stringify(report).includes('secret-api-key'), false);
});

test('remote sync does not write config while a plugin restart is pending', async () => {
  let settingsCalled = false;
  const client = clientWith({
    '/api/ssh-remote/plugins/install': async () => ({ ok: true, result: { application: 'restart-required', pendingBuilds: [] } }),
    '/api/ssh-remote/settings/update': async () => { settingsCalled = true; return { ok: true }; },
  });
  const report = await syncRemote(client, {
    plugins: [{ spec: '@local/example' }],
    settings: [{ ns: 'theme', patch: { theme: 'dark' } }],
  });
  assert.equal(report.restartRequired, true);
  assert.equal(settingsCalled, false);
});
