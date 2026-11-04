import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../../packages/shell/ssh-remote/plugins/status/src/host/index.js';

function fixture() {
  const routes = new Map();
  const calls = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: {
      async listBundles() { return []; },
      async installBundle(spec, options) {
        calls.push({ method: 'installBundle', spec, options });
        return { application: 'applied', pendingBuilds: [] };
      },
    },
    settings: {
      describe() { return []; },
      async update(ns, patch, expectedRevision) { calls.push({ method: 'settings.update', ns, patch, expectedRevision }); },
    },
    credentials: {
      async set(ref, value) { calls.push({ method: 'credentials.set', ref, value }); },
      async describe(ref) { return { configured: true, writable: true }; },
    },
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'p0-linux', dshVersion: '0.2.1-rc.5' });
  return { routes, calls };
}

test('remote credential route writes the secret without returning it', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/credentials/set').fetch(new Request('http://localhost/api/ssh-remote/credentials/set', {
    method: 'POST',
    body: JSON.stringify({ ref: 'SSH_REMOTE_P0_KEY', value: 'secret-api-key' }),
  }));
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.equal(value.credential.configured, true);
  assert.equal(JSON.stringify(value).includes('secret-api-key'), false);
  assert.deepEqual(calls[0], { method: 'credentials.set', ref: 'SSH_REMOTE_P0_KEY', value: 'secret-api-key' });
});

test('remote plugin route forwards only explicit build approvals', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/plugins/install').fetch(new Request('http://localhost/api/ssh-remote/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ spec: '@local/example@1.0.0', requestId: 'p0-install', approvedBuilds: ['allowed-package'] }),
  }));
  assert.equal((await response.json()).ok, true);
  assert.equal(calls[0].method, 'installBundle');
  assert.deepEqual(calls[0].options.approvedBuilds, ['allowed-package']);
  assert.equal(calls[0].options.saveExact, true);
});

test('remote settings route calls the existing settings service', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/settings/update').fetch(new Request('http://localhost/api/ssh-remote/settings/update', {
    method: 'POST',
    body: JSON.stringify({ ns: 'ui-theme', patch: { preference: 'dark', fontSize: 14 }, expectedRevision: 3 }),
  }));
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(calls[0], {
    method: 'settings.update', ns: 'ui-theme',
    patch: { preference: 'dark', fontSize: 14 }, expectedRevision: 3,
  });
});

test('remote routes reject oversized bodies before reading credentials', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/credentials/set').fetch(new Request('http://localhost/api/ssh-remote/credentials/set', {
    method: 'POST',
    body: `{"ref":"SSH_REMOTE_P0_KEY","value":"${'x'.repeat(65 * 1024)}"}`,
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
  assert.equal(calls.length, 0);
});
