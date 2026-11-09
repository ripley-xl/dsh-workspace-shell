import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../../packages/status/src/host/index.js';

function fixture() {
  const routes = new Map();
  const calls = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return []; }, async installBundle() { throw new Error('not expected'); } },
    settings: { describe: () => [], async update() {} },
    credentials: {
      async describe(ref) {
        calls.push(ref);
        return { configured: ref === 'CONFIGURED_KEY', writable: true, value: 'remote-secret-must-not-leak' };
      },
      async set() {},
    },
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'p0-test', dshVersion: '1.0.0' });
  return { routes, calls };
}

test('remote credential preview returns only configured and writable state', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/credentials/describe').fetch(new Request('http://localhost/api/ssh-remote/credentials/describe', {
    method: 'POST', body: JSON.stringify({ refs: ['CONFIGURED_KEY', 'MISSING_KEY', 'CONFIGURED_KEY'] }),
  }));
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.deepEqual(value.credentials, {
    CONFIGURED_KEY: { configured: true, writable: true },
    MISSING_KEY: { configured: false, writable: true },
  });
  assert.deepEqual(calls, ['CONFIGURED_KEY', 'MISSING_KEY']);
  assert.equal(JSON.stringify(value).includes('remote-secret-must-not-leak'), false);
  assert.equal('value' in value.credentials.CONFIGURED_KEY, false);
});

test('remote credential preview bounds the requested refs before describing them', async () => {
  const { routes, calls } = fixture();
  const response = await routes.get('/api/ssh-remote/credentials/describe').fetch(new Request('http://localhost/api/ssh-remote/credentials/describe', {
    method: 'POST', body: JSON.stringify({ refs: Array.from({ length: 129 }, (_, index) => `KEY_${index}`) }),
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
