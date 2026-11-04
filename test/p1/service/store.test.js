import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionStore, validateConnectionRecord } from '../../../packages/shell/ssh-remote/src/host/store.js';
import { memoryStorage } from './helpers.mjs';

test('connection store persists only declared non-secret fields', async () => {
  const storageDomain = memoryStorage();
  const store = await new ConnectionStore(storageDomain).open();
  const record = await store.upsert({
    name: 'Test host',
    hostAlias: 'p0-test',
    defaultWorkspace: '/home/test/work',
    pluginTemplate: [{ spec: '@local/example@1.0.0', approvedBuilds: ['example'] }],
    syncPolicy: { appearance: true, modelNamespaces: ['model'], credentialRefs: ['TEST_API_KEY'] },
    value: 'must-not-persist',
    token: 'must-not-persist',
  });
  assert.equal(record.syncPolicy.credentialRefs[0], 'TEST_API_KEY');
  assert.equal(JSON.stringify(record).includes('must-not-persist'), false);
  assert.equal(record.lastInstanceId, null);
  await store.markConnected(record.id, { instanceId: 'instance-1', version: '1.0.0', buildId: 'build-1' });
  await store.close();

  const reopened = await new ConnectionStore(storageDomain).open();
  const saved = reopened.get(record.id);
  assert.equal(saved.lastInstanceId, 'instance-1');
  assert.equal(saved.lastBuildId, 'build-1');
  assert.equal('pluginTemplate' in saved, false);
  assert.equal('defaultWorkspace' in saved, false);
  await reopened.close();
});

test('connection store upserts by alias and rejects duplicate aliases', async () => {
  const store = await new ConnectionStore(memoryStorage()).open();
  const created = await store.upsert({ hostAlias: 'p0-test' });
  const updated = await store.upsert({ hostAlias: 'p0-test', name: 'Renamed' });
  assert.equal(updated.id, created.id);
  const other = await store.upsert({ hostAlias: 'other' });
  await assert.rejects(store.upsert({ id: other.id, hostAlias: 'p0-test' }), (error) => error.code === 'HOST_ALIAS_EXISTS');
  await store.upsert({ id: created.id, hostAlias: 'renamed' });
  assert.equal(store.get(created.id).hostAlias, 'renamed');
  await store.close();
});

test('connection records ignore legacy directory/template fields and reject malformed credential refs', async () => {
  const store = await new ConnectionStore(memoryStorage()).open();
  const record = await store.upsert({
    hostAlias: 'p0-test',
    defaultWorkspace: 'legacy/path',
    pluginTemplate: [{ spec: '@local/legacy@1.0.0' }],
  });
  assert.equal('defaultWorkspace' in record, false);
  assert.equal('pluginTemplate' in record, false);
  await assert.rejects(store.upsert({ hostAlias: 'p0-test', syncPolicy: { credentialRefs: ['BAD-REF'] } }), (error) => error.code === 'INVALID_CONNECTION_RECORD');
  assert.throws(() => validateConnectionRecord({}), (error) => error.code === 'INVALID_CONNECTION_RECORD');
  await store.close();
});
