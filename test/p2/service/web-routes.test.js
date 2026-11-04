import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject } from '../../../packages/manager/src/host/index.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

async function routesFixture(t) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return [{ name: '@deepseek-ai/dsh-web-app', version: '1.0.0' }]; } },
    settings: { describe: () => [] },
    credentials: { async resolve() { throw new Error('not expected'); } },
    storageDomain: memoryStorage(),
    get() { return { getAdvertisedUrl: () => 'http://127.0.0.1:54542/?tkn=local-secret' }; },
    effect(callback) { disposers.push(callback()); },
  };
  await apply(ctx);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  return { routes };
}

function route(routes, path, value) {
  return routes.get(path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(value ?? {}),
  }));
}

async function host(routes) {
  const created = await (await route(routes, '/api/ssh-remote/hosts', {
    hostAlias: 'p0-test', syncPolicy: { appearance: false },
  })).json();
  return created.host;
}

test('web routes exist with the agreed paths and reject bad input safely', async (t) => {
  const { routes } = await routesFixture(t);
  assert.ok(inject.includes('storageDomain'));
  for (const path of ['/api/ssh-remote/web/list', '/api/ssh-remote/web/open', '/api/ssh-remote/web/attach', '/api/ssh-remote/web/stop', '/api/ssh-remote/autoconnect']) {
    assert.equal(typeof routes.get(path)?.fetch, 'function', path);
  }
  const saved = await host(routes);

  const missingHost = await route(routes, '/api/ssh-remote/web/list', { hostId: 'missing' });
  assert.equal(missingHost.status, 404);
  assert.equal((await missingHost.json()).error.code, 'HOST_NOT_FOUND');

  // Without a real SSH transport the open fails with a structured, non-200 error.
  const unreachable = await route(routes, '/api/ssh-remote/web/open', { hostId: saved.id });
  assert.equal(unreachable.status >= 400, true);
  assert.equal((await unreachable.json()).ok, false);

  const badAttach = await route(routes, '/api/ssh-remote/web/attach', { hostId: saved.id });
  assert.equal(badAttach.status, 400);
  assert.equal((await badAttach.json()).error.code, 'INVALID_REQUEST');

  const badStop = await route(routes, '/api/ssh-remote/web/stop', { hostId: saved.id });
  assert.equal(badStop.status, 400);
  assert.equal((await badStop.json()).error.code, 'INVALID_REQUEST');

  const badProfile = await route(routes, '/api/ssh-remote/web/open', { hostId: saved.id, profileId: '../../etc' });
  assert.equal(badProfile.status, 400);
  assert.equal((await badProfile.json()).error.code, 'INVALID_REQUEST');

  const badAuto = await route(routes, '/api/ssh-remote/autoconnect', { hostId: saved.id, autoConnect: 'yes' });
  assert.equal(badAuto.status, 400);
  assert.equal((await badAuto.json()).error.code, 'INVALID_REQUEST');
});

test('the host record exposes autoConnect=false by default and accepts toggles', async (t) => {
  const { routes } = await routesFixture(t);
  const saved = await host(routes);
  assert.equal(saved.autoConnect, false);
  const on = await (await route(routes, '/api/ssh-remote/autoconnect', { hostId: saved.id, autoConnect: true })).json();
  assert.equal(on.host.autoConnect, true);
  const off = await (await route(routes, '/api/ssh-remote/autoconnect', { hostId: saved.id, autoConnect: false })).json();
  assert.equal(off.host.autoConnect, false);
});

test('web/list returns only safe host fields and never the authenticated URL', async (t) => {
  const { routes } = await routesFixture(t);
  const saved = await host(routes);
  const listed = await route(routes, '/api/ssh-remote/web/list', { hostId: saved.id });
  assert.equal(listed.status, 200);
  const value = await listed.json();
  assert.equal(value.ok, true);
  assert.deepEqual(value.profiles, [{ id: 'web', web: true }]);
  assert.deepEqual(value.hosts, []);
  const text = JSON.stringify(value);
  assert.equal(text.includes('tkn='), false);
  assert.equal(text.includes('local-secret'), false);
  assert.equal(text.includes('browserUrl'), false);
});
