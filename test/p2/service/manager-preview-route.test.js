import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../../packages/manager/src/host/index.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

test('manager registers sync preview and returns structured disconnected errors', async (t) => {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return [{ name: '@deepseek-ai/dsh-web-app', version: '1.0.0', installed: true, enabled: true }]; } },
    settings: { describe: () => [] },
    credentials: { async describe() { return { configured: false, writable: true }; }, async resolve() { throw new Error('not expected'); } },
    storageDomain: memoryStorage(),
    get() { return { getAdvertisedUrl: () => 'http://127.0.0.1:54542' }; },
    effect(callback) { disposers.push(callback()); },
  };
  await apply(ctx);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  const createdResponse = await routes.get('/api/ssh-remote/hosts').fetch(new Request('http://localhost/api/ssh-remote/hosts', {
    method: 'POST', body: JSON.stringify({ hostAlias: 'p0-test', syncPolicy: { appearance: false } }),
  }));
  const created = await createdResponse.json();
  const response = await routes.get('/api/ssh-remote/sync/preview').fetch(new Request('http://localhost/api/ssh-remote/sync/preview', {
    method: 'POST', body: JSON.stringify({ hostId: created.host.id }),
  }));
  assert.equal(response.status, 409);
  const value = await response.json();
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'HOST_NOT_CONNECTED');
});
