import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionStore, validateConnectionRecord } from '../../../packages/shell/ssh-remote/src/host/store.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

test('ConnectionRecord drops defaultWorkspace and pluginTemplate including legacy fields', async () => {
  const store = await new ConnectionStore(memoryStorage()).open();
  const record = await store.upsert({
    name: 'Linux', hostAlias: 'linux-dev', defaultWorkspace: '/legacy/workspace',
    pluginTemplate: [{ spec: '@legacy/plugin', version: '1.0.0' }],
    syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: [] },
  });
  assert.equal('defaultWorkspace' in record, false);
  assert.equal('pluginTemplate' in record, false);
  const legacy = validateConnectionRecord({
    ...record,
    defaultWorkspace: '/another/legacy/path',
    pluginTemplate: [{ spec: '@legacy/another' }],
  });
  assert.equal('defaultWorkspace' in legacy, false);
  assert.equal('pluginTemplate' in legacy, false);
  assert.deepEqual(store.get(record.id), legacy);
  await store.close();
});
