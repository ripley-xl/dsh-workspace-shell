import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionStore, validateConnectionRecord } from '../../../packages/manager/src/host/store.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

test('new and legacy ConnectionRecords default allSupported to true', async () => {
  const store = await new ConnectionStore(memoryStorage()).open();
  const record = await store.upsert({ hostAlias: 'linux-dev', syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: [] } });
  assert.equal(record.syncPolicy.allSupported, true);
  const legacy = validateConnectionRecord({ ...record, syncPolicy: { appearance: false, modelNamespaces: ['legacy'], credentialRefs: ['LEGACY_KEY'] } });
  assert.equal(legacy.syncPolicy.allSupported, true);
  const disabled = await store.upsert({ id: record.id, syncPolicy: { allSupported: false } });
  assert.equal(disabled.syncPolicy.allSupported, false);
  await store.close();
});
