import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../../packages/manager/src/host/index.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

const INSTALLATION_BUNDLES = [
  {
    name: '@deepseek-ai/dsh-base', official: false, availability: 'installation', version: '0.2.1-rc.5',
    enabled: true, installed: false, optional: false, removable: false,
  },
  {
    name: '@deepseek-ai/dsh-web-app', official: false, availability: 'installation', version: '0.2.1-rc.5',
    enabled: true, installed: false, optional: false, removable: false,
  },
];

async function fixture(t, bundles = INSTALLATION_BUNDLES) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return bundles; } },
    settings: { describe: () => [] },
    credentials: { async describe() { return { configured: false, writable: true }; }, async resolve() { throw new Error('not expected'); } },
    storageDomain: memoryStorage(),
    get() { return { getAdvertisedUrl: () => 'http://127.0.0.1:54542' }; },
    effect(callback) { disposers.push(callback()); },
  };
  await apply(ctx);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  return { routes };
}

test('status resolves the real installation-provided bundle version', async (t) => {
  const { routes } = await fixture(t);
  const response = await routes.get('/api/ssh-remote/status').fetch(new Request('http://localhost/api/ssh-remote/status'));
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.equal(value.dshVersion, '0.2.1-rc.5');
});

test('initial SSE status carries the same resolved version', async (t) => {
  const { routes } = await fixture(t);
  const response = await routes.get('/api/ssh-remote/events').fetch(new Request('http://localhost/api/ssh-remote/events'));
  const reader = response.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  const data = JSON.parse(text.match(/^data: (.+)$/mu)[1]);
  assert.equal(data.dshVersion, '0.2.1-rc.5');
  await reader.cancel();
});

test('a disabled web bundle falls back to the enabled base version', async (t) => {
  const bundles = [
    { ...INSTALLATION_BUNDLES[0], version: '0.2.1-rc.5' },
    { ...INSTALLATION_BUNDLES[1], enabled: false },
  ];
  const { routes } = await fixture(t, bundles);
  const value = await (await routes.get('/api/ssh-remote/status').fetch(new Request('http://localhost/api/ssh-remote/status'))).json();
  assert.equal(value.dshVersion, '0.2.1-rc.5');
});
