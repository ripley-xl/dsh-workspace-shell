import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSyncInput, buildSyncPreview } from '../../../packages/shell/ssh-remote/src/host/sync-input.js';

const BUNDLES = [
  { name: '@deepseek-ai/optional-on', official: true, optional: true, enabled: true, installed: false, availability: 'installation', version: '1.0.0' },
  { name: '@deepseek-ai/optional-off', official: true, optional: true, enabled: false, installed: false, availability: 'installation', version: '1.0.0' },
  { name: 'third-party', official: false, optional: false, enabled: true, installed: true, availability: 'profile', version: '2.0.0' },
];

test('official optional bundles become enabled-state plans rather than install templates', async () => {
  const input = await buildSyncInput({
    pluginTemplate: [
      { spec: '@deepseek-ai/optional-on', version: '1.0.0' },
      { spec: 'third-party', version: '2.0.0' },
    ],
    syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: [] },
  }, { descriptors: [], bundles: BUNDLES });
  assert.deepEqual(input.officialBundles, [
    { name: '@deepseek-ai/optional-on', version: '1.0.0', enabled: true },
    { name: '@deepseek-ai/optional-off', version: '1.0.0', enabled: false },
  ]);
  assert.deepEqual(input.plugins.map((plugin) => plugin.spec), ['third-party@2.0.0']);
});

test('official preview compares local and remote enabled state', async () => {
  const preview = await buildSyncPreview({
    syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: [] },
  }, {
    descriptors: [], bundles: BUNDLES,
    remoteBundles: [
      { name: '@deepseek-ai/optional-on', official: true, optional: true, enabled: false, installed: false, availability: 'installation', version: '1.0.0' },
      { name: '@deepseek-ai/optional-off', official: true, optional: true, enabled: true, installed: false, availability: 'installation', version: '1.0.0' },
    ],
  });
  const operations = preview.operations.filter((operation) => operation.type === 'official-plugin');
  assert.deepEqual(operations.map((operation) => [operation.name, operation.action, operation.wouldChange]), [
    ['@deepseek-ai/optional-on', 'enable', true],
    ['@deepseek-ai/optional-off', 'disable', true],
  ]);
  assert.equal(preview.operations.some((operation) => operation.type === 'plugin'), false);
});
