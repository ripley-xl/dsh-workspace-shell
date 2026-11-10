import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject } from '../../../packages/manager/src/host/index.js';
import { memoryStorage } from './helpers.mjs';

async function routeFixture(t) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return [{ name: '@deepseek-ai/dsh-web-app', version: '1.0.0' }]; } },
    settings: { describe: () => [{ ns: 'ui-theme', value: { preference: 'dark' } }] },
    credentials: { async resolve() { throw new Error('not expected'); } },
    storageDomain: memoryStorage(),
    get() { return { getAdvertisedUrl: () => 'http://127.0.0.1:54542/?tkn=local-secret' }; },
    effect(callback) { disposers.push(callback()); },
  };
  await apply(ctx);
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose?.();
  });
  return { routes, ctx };
}

function post(route, value, raw) {
  return route.fetch(new Request(`http://localhost${route.path}`, {
    method: 'POST',
    body: raw ?? JSON.stringify(value),
  }));
}

test('manager routes upsert and remove hosts with structured errors', async (t) => {
  const { routes } = await routeFixture(t);
  assert.ok(inject.includes('storageDomain'));
  const createdResponse = await post(routes.get('/api/ssh-remote/hosts'), {
    action: 'upsert', host: { hostAlias: 'p0-test', syncPolicy: { appearance: false } },
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);
  assert.equal(created.host.hostAlias, 'p0-test');
  const status = await (await routes.get('/api/ssh-remote/status').fetch(new Request('http://localhost/api/ssh-remote/status'))).json();
  assert.equal(status.connections.length, 1);
  assert.equal(status.dshVersion, '1.0.0');
  assert.equal(JSON.stringify(status).includes('local-secret'), false);
  const missing = await post(routes.get('/api/ssh-remote/connect'), { hostId: 'missing' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'HOST_NOT_FOUND');
  const removed = await post(routes.get('/api/ssh-remote/hosts'), { action: 'remove', hostId: created.host.id });
  assert.equal((await removed.json()).removed, true);
});

test('manager routes reject oversized bodies before changing stored hosts', async (t) => {
  const { routes } = await routeFixture(t);
  const response = await post(routes.get('/api/ssh-remote/hosts'), null, `{"hostAlias":"${'x'.repeat(129 * 1024)}"}`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  const status = await (await routes.get('/api/ssh-remote/status').fetch(new Request('http://localhost/api/ssh-remote/status'))).json();
  assert.equal(status.connections.length, 0);
});

test('event stream publishes authenticated status without browser URLs or local tokens', async (t) => {
  const { routes } = await routeFixture(t);
  const response = await routes.get('/api/ssh-remote/events').fetch(new Request('http://localhost/api/ssh-remote/events'));
  assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  const reader = response.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /^event: status\ndata: /u);
  assert.equal(text.includes('local-secret'), false);
  assert.equal(text.includes('browserUrl'), false);
  await reader.cancel();
});

test('P2 routes expose ports and structured interaction failures', async (t) => {
  const { routes } = await routeFixture(t);
  const created = await (await post(routes.get('/api/ssh-remote/hosts'), {
    action: 'upsert', host: { hostAlias: 'p2-routes', syncPolicy: { appearance: false } },
  })).json();
  const hostId = created.host.id;

  const listed = await (await post(routes.get('/api/ssh-remote/ports'), { hostId, action: 'list' })).json();
  assert.deepEqual(listed.forwards, []);
  const unavailable = await post(routes.get('/api/ssh-remote/ports'), {
    hostId, action: 'add', forward: { remotePort: 8080, localPort: 0 },
  });
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).error.code, 'HOST_NOT_CONNECTED');

  const stale = await post(routes.get('/api/ssh-remote/interaction'), { requestId: 'stale', value: 'secret' });
  assert.equal((await stale.json()).error.code, 'INTERACTION_NOT_FOUND');
});
