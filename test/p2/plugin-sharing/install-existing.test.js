import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../../../packages/status/src/host/index.js';

function fixture({ installed = true, enabled = true, version = '0.6.5' } = {}) {
  const routes = new Map();
  const calls = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: {
      async installBundle() {
        return { application: 'failed', changed: false, error: { code: 'already-installed' } };
      },
      async listBundles() {
        return installed ? [{ name: '@nonamelego/dsh-catppuccin', version, enabled }] : [];
      },
      async setBundleEnabled(name, value) {
        calls.push({ name, enabled: value });
        return { application: 'applied', changed: true, enabled: true };
      },
    },
    settings: { describe() { return []; } },
    credentials: {},
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'test', dshVersion: '1.0.0' });
  return { routes, calls };
}

async function install(routes, spec = '@nonamelego/dsh-catppuccin@0.6.5') {
  const response = await routes.get('/api/ssh-remote/plugins/install').fetch(new Request('http://localhost/api/ssh-remote/plugins/install', {
    method: 'POST', body: JSON.stringify({ spec, requestId: 'install-existing' }),
  }));
  return response.json();
}

test('installing an already installed enabled plugin is idempotent', async () => {
  const { routes } = fixture();
  const result = await install(routes);
  assert.equal(result.ok, true);
  assert.equal(result.result.application, 'applied');
  assert.equal(result.result.alreadyInstalled, true);
  assert.equal(result.result.error, undefined);
});

test('installing an already installed disabled plugin enables it', async () => {
  const { routes, calls } = fixture({ enabled: false });
  const result = await install(routes);
  assert.equal(result.ok, true);
  assert.equal(result.result.alreadyInstalled, true);
  assert.deepEqual(calls, [{ name: '@nonamelego/dsh-catppuccin', enabled: true }]);
});

test('an installed different version is an explicit version conflict', async () => {
  const { routes } = fixture({ version: '0.6.4' });
  const result = await install(routes);
  assert.equal(result.ok, false);
  assert.equal(result.result.error.code, 'PLUGIN_VERSION_MISMATCH');
  assert.equal(result.result.error.details.remoteVersion, '0.6.4');
});
