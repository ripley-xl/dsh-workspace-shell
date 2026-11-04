import assert from 'node:assert/strict';
import test from 'node:test';

import { shareLocalPlugins } from '../../../packages/shell/ssh-remote/src/host/plugin-share.js';
import { RemoteClient } from '../../../packages/shell/ssh-remote/src/host/remote-client.js';
import { apply } from '../../../packages/shell/ssh-remote/plugins/status/src/host/index.js';

function remoteBundle(name, overrides = {}) {
  return {
    name,
    official: true,
    optional: true,
    enabled: false,
    installed: true,
    removable: true,
    availability: 'profile',
    version: '1.0.0',
    ...overrides,
  };
}

async function integration() {
  const routes = new Map();
  const calls = [];
  const remote = [remoteBundle('@official/example'), remoteBundle('@third-party/example', { official: false })];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: {
      async listBundles() { return remote; },
      async setBundleEnabled(name, enabled) {
        calls.push({ method: 'setBundleEnabled', name, enabled });
        const target = remote.find((item) => item.name === name);
        if (!target) return { changed: false, application: 'failed', error: { diagnostic: 'unknown bundle' } };
        target.enabled = enabled;
        return { changed: true, application: 'applied', stage: 'enable', target: name, enabled };
      },
      async installBundle(spec, options) {
        calls.push({ method: 'installBundle', spec, options });
        return { changed: true, application: 'applied', stage: 'install', target: spec, pendingBuilds: [] };
      },
      async removeBundle(name) {
        calls.push({ method: 'removeBundle', name });
        return { changed: true, application: 'applied', stage: 'remove', target: name };
      },
      async setVersionExemption() { throw new Error('not allowed'); },
    },
    settings: { describe: () => [], async update() {} },
    credentials: { async describe() { return { configured: false, writable: true }; }, async set() {} },
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'integration', dshVersion: '1.0.0' });

  const requests = [];
  const client = new RemoteClient({
    authenticatedUrl: 'http://127.0.0.1:41000/?tkn=integration-secret',
    gatewayOrigin: 'http://localhost:52000',
    async fetchImpl(url, options = {}) {
      requests.push({ url: String(url), options });
      if (!options.method) {
        return new Response(null, {
          status: 302,
          headers: { 'set-cookie': 'browser-credential=integration-cookie; Path=/; HttpOnly' },
        });
      }
      assert.equal(options.headers.cookie, 'browser-credential=integration-cookie');
      const target = new URL(url);
      assert.equal(target.search.includes('tkn'), false);
      const route = routes.get(target.pathname);
      assert.ok(route, `missing route ${target.pathname}`);
      return route.fetch(new Request(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      }));
    },
  });
  return { client, calls, remote, requests };
}

test('RemoteClient uploads a safe inventory and synchronizes official state through authenticated routes', async () => {
  const { client, calls, remote, requests } = await integration();
  const report = await shareLocalPlugins(client, [
    remoteBundle('@official/example', {
      enabled: true,
      source: 'npm',
      installTarget: { spec: '@official/example@1.0.0', version: '1.0.0' },
      browserUrl: 'http://127.0.0.1/?tkn=local-secret',
      credentials: { TOKEN: 'local-secret' },
    }),
    remoteBundle('@third-party/example', { official: false, enabled: true }),
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(calls, [{ method: 'setBundleEnabled', name: '@official/example', enabled: true }]);
  assert.equal(remote[0].enabled, true);
  assert.equal(remote[1].enabled, false);

  const page = await client.post('/api/ssh-remote/plugins/page', {});
  assert.equal(page.ok, true);
  assert.equal(page.local.bundles.length, 2);
  assert.deepEqual(page.remote, remote);
  assert.equal(JSON.stringify(page.local).includes('local-secret'), false);
  assert.equal(JSON.stringify(page.local).includes('browserUrl'), false);
  assert.equal(JSON.stringify(page.local).includes('credentials'), false);
  assert.equal(requests.filter((request) => !request.options.method).length, 1);
  client.close();
});

test('RemoteClient supports one-click install, enablement and removal on the same routes', async () => {
  const { client, calls } = await integration();
  const installed = await client.post('/api/ssh-remote/plugins/install', {
    spec: '@official/example@1.0.0', requestId: 'integration-install', approvedBuilds: ['example-build'],
  });
  assert.equal(installed.ok, true);
  const enabled = await client.post('/api/ssh-remote/plugins/set-enabled', { name: '@official/example', enabled: true });
  assert.equal(enabled.ok, true);
  const removed = await client.post('/api/ssh-remote/plugins/remove', { name: '@official/example' });
  assert.equal(removed.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['installBundle', 'setBundleEnabled', 'removeBundle']);
  assert.deepEqual(calls[0].options, {
    enabled: true,
    saveExact: true,
    requestId: 'integration-install',
    approvedBuilds: ['example-build'],
  });
  client.close();
});
