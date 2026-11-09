import assert from 'node:assert/strict';
import test from 'node:test';

import { SshRemoteService } from '../../../packages/manager/src/host/service.js';
import { ConnectionStore } from '../../../packages/manager/src/host/store.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

const artifact = {
  artifactPath: '/artifacts/dsh-1.0.0.tar.gz',
  filename: 'dsh-1.0.0.tar.gz',
  runtimeId: '1.0.0-linux-x64-glibc',
  dshVersion: '1.0.0',
  version: '1.0.0',
  buildId: 'build-1',
  sha256: 'a'.repeat(64),
  size: 1,
  target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
};

function harness({ autoConnectOnStart = true, connectResolves = true } = {}) {
  const storage = memoryStorage();
  const store = new ConnectionStore(storage);
  const calls = [];
  let resolveConnect;
  const gate = new Promise((resolve) => { resolveConnect = resolve; });
  const service = new SshRemoteService({
    store,
    autoConnectOnStart,
    catalog: { select: async () => artifact },
    localVersion: async () => '1.0.0',
    localReturnUrl: 'http://127.0.0.1:54542/?tkn=local-secret',
    settings: { describe: () => [] },
    credentials: { async resolve() { throw new Error('not expected'); } },
    openControllerSession: async () => {
      calls.push('connect');
      if (!connectResolves) {
        throw Object.assign(new Error('interactive authentication required'), {
          code: 'SSH_AUTH_INTERACTION_REQUIRED',
          details: { password: 'do-not-leak-this' },
        });
      }
      await gate;
      throw Object.assign(new Error('transport refused'), { code: 'SSH_CONNECTION_FAILED' });
    },
  });
  return {
    service, store, calls, resolveConnect,
    async close() { await service.close(); await store.close(); },
  };
}

test('service creation does not block on autoConnect records', async (t) => {
  const { service, store, calls, close } = harness({ connectResolves: false });
  t.after(close);
  await store.open();
  await store.upsert({ hostAlias: 'p0-test', autoConnect: true });
  const started = Date.now();
  await service.autoConnectAll();
  assert.ok(Date.now() - started < 250);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, ['connect']);
  const connection = service.publicConnection(store.list()[0].id);
  assert.equal(connection.phase, 'failed');
  assert.equal(JSON.stringify(connection).includes('do-not-leak-this'), false);
  assert.equal(connection.error.details.password, '[redacted]');
});

test('autoConnect failures stay structured and never prompt interactively', async (t) => {
  const { service, store, close } = harness({ connectResolves: false });
  t.after(close);
  await store.open();
  const record = await store.upsert({ hostAlias: 'p0-test', autoConnect: true });
  await service.autoConnectAll();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const connection = service.publicConnection(record.id);
  assert.equal(connection.phase, 'failed');
  assert.equal(connection.error.code, 'SSH_AUTH_INTERACTION_REQUIRED');
  assert.equal(service.interactions.pending.size, 0);
});

test('connecting records fire once per autoConnect start', async (t) => {
  const { service, store, calls, resolveConnect, close } = harness();
  t.after(close);
  await store.open();
  const record = await store.upsert({ hostAlias: 'p0-test', autoConnect: true });
  await store.upsert({ hostAlias: 'manual-only' });
  await service.autoConnectAll();
  await service.autoConnectAll();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['connect']);
  resolveConnect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.publicConnection(record.id).phase, 'failed');
});

test('autoConnectOnStart=false leaves the service idle', async (t) => {
  const { service, store, calls, close } = harness({ autoConnectOnStart: false });
  t.after(close);
  await store.open();
  await store.upsert({ hostAlias: 'p0-test', autoConnect: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(calls, []);
  await service.close();
});
