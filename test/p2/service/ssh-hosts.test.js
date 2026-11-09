import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../../packages/manager/src/host/index.js';
import { memoryStorage, serviceFixture } from '../../p1/service/helpers.mjs';

test('sshHosts returns the configured OpenSSH host list through the service boundary', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const hosts = [{ alias: 'linux-dev', hostName: '127.0.0.1', user: 'test', port: 22, source: '/tmp/ssh_config' }];
  fixture.service.listConfiguredSshHosts = async () => hosts;
  assert.deepEqual(await fixture.service.sshHosts(), { ok: true, hosts });
  assert.deepEqual(await fixture.service.sshHosts({ query: 'LINUX' }), { ok: true, hosts });
  assert.deepEqual(await fixture.service.sshHosts({ query: 'absent' }), { ok: true, hosts: [] });
});

test('manager registers GET and POST ssh-hosts without reading user configuration', async (t) => {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: { async listBundles() { return []; } },
    settings: { describe: () => [] },
    credentials: { async describe() { return { configured: false, writable: true }; } },
    storageDomain: memoryStorage(),
    get() { return { getAdvertisedUrl: () => 'http://127.0.0.1:54542' }; },
    effect(callback) { disposers.push(callback()); },
  };
  await apply(ctx);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  assert.deepEqual(routes.get('/api/ssh-remote/ssh-hosts').methods, ['GET', 'POST']);
});
