import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSyncInput, buildSyncPreview } from '../../../packages/shell/ssh-remote/src/host/sync-input.js';

const TEST_CREDENTIAL_SCHEMA = { properties: { apiKeyEnv: { default: 'TEST_KEY', 'x-cordis': { role: 'credential-ref' } } } };

function record() {
  return {
    pluginTemplate: [
      { spec: '@local/theme', version: '2.0.0', pendingBuilds: ['build-wait'] },
      { spec: '@local/native', version: '1.0.0' },
      { spec: '@local/old', version: '3.0.0' },
    ],
    syncPolicy: { appearance: true, modelNamespaces: ['model'], credentialRefs: ['TEST_KEY'] },
  };
}

test('preview reports field differences, conflicts, preserved paths and structured blockers', async () => {
  const preview = await buildSyncPreview(record(), {
    descriptors: [
      { ns: 'ui-theme', value: { preference: 'dark', fontSize: 14, nested: { accent: 'blue' } } },
      { ns: 'model', schema: TEST_CREDENTIAL_SCHEMA, value: { baseURL: 'https://example.com', apiKey: 'local-secret' }, secrets: [{ path: ['apiKey'], set: true }] },
    ],
    localCredentials: { TEST_KEY: { configured: true, writable: true } },
    remoteCredentials: { TEST_KEY: { configured: true, writable: true } },
    remoteDescriptors: [
      {
        ns: 'ui-theme', revision: 7,
        value: { preference: 'light', fontSize: 14, nested: { accent: 'blue' }, remoteOnly: 'keep' },
        user: { preference: 'light', remoteOnly: 'keep' },
      },
      {
        ns: 'model',
        value: { baseURL: 'https://old.example.com', apiKey: 'remote-secret', remoteModel: 'keep' },
        user: { apiKey: 'remote-secret', remoteModel: 'keep' },
        secrets: [{ path: ['apiKey'], set: true }],
      },
    ],
    remoteBundles: [
      { name: '@local/theme', version: '1.0.0', installed: true, enabled: true, pendingBuilds: ['build-wait'] },
      { name: '@local/native', version: '1.0.0', installed: true, enabled: true, os: ['linux'], cpu: ['x64'] },
      { name: '@local/old', version: '2.0.0', installed: true, enabled: true, error: { code: 'incompatible-version', incompatible: [{ name: '@local/old', version: '3.0.0' }] } },
    ],
    target: { platform: 'linux', arch: 'arm64', libc: 'glibc' },
    dshVersion: '1.0.0',
  });
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.canSync, false);
  assert.equal(preview.preservesUnmanagedFields, true);
  const preference = preview.fields.find((field) => field.ns === 'ui-theme' && field.path.join('.') === 'preference');
  assert.equal(preference.conflict, true);
  assert.equal(preference.localValue, 'dark');
  assert.equal(preference.remoteValue, 'light');
  const baseURL = preview.fields.find((field) => field.ns === 'model' && field.path.join('.') === 'baseURL');
  assert.equal(baseURL.status, 'changed');
  assert.equal(baseURL.conflict, false);
  assert.ok(preview.preservedFields.some((field) => field.ns === 'ui-theme' && field.path.join('.') === 'remoteOnly'));
  assert.ok(preview.preservedFields.some((field) => field.ns === 'model' && field.path.join('.') === 'remoteModel'));
  const codes = preview.operations.filter((operation) => operation.type === 'plugin').map((operation) => operation.code);
  assert.deepEqual(codes, ['PLUGIN_BUILD_APPROVAL_REQUIRED', 'PLUGIN_PLATFORM_INCOMPATIBLE', 'PLUGIN_VERSION_INCOMPATIBLE']);
  const credential = preview.operations.find((operation) => operation.type === 'credential');
  assert.deepEqual(credential.configured, { local: true, remote: true });
  assert.equal(credential.comparison, 'configured-only');
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes('local-secret'), false);
  assert.equal(serialized.includes('remote-secret'), false);
});

test('preview builds credential operations without resolving local secret values', async () => {
  let resolveCalled = false;
  const input = await buildSyncInput({
    pluginTemplate: [], syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: ['TEST_KEY'] },
  }, {
    descriptors: [{ ns: 'model', schema: TEST_CREDENTIAL_SCHEMA, value: { apiKeyEnv: 'TEST_KEY' }, user: {} }], includeCredentialValues: false,
    resolveCredential: async () => { resolveCalled = true; return { value: 'secret' }; },
  });
  assert.deepEqual(input.credentials, [{ ref: 'TEST_KEY' }]);
  assert.equal(resolveCalled, false);
  const preview = await buildSyncPreview({
    pluginTemplate: [], syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: ['TEST_KEY'] },
  }, {
    descriptors: [{ ns: 'model', schema: TEST_CREDENTIAL_SCHEMA, value: { apiKeyEnv: 'TEST_KEY' }, user: {} }],
    localCredentials: { TEST_KEY: { configured: true } },
    remoteCredentials: { TEST_KEY: { configured: false, writable: true } },
  });
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.operations[0].wouldChange, true);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
});

test('a remote default difference is a planned update rather than a user conflict', async () => {
  const preview = await buildSyncPreview({
    pluginTemplate: [], syncPolicy: { appearance: false, modelNamespaces: ['model'], credentialRefs: [] },
  }, {
    descriptors: [{ ns: 'model', value: { baseURL: 'https://local.example.com' } }],
    remoteDescriptors: [{ ns: 'model', value: { baseURL: 'https://remote.example.com' }, base: { baseURL: 'https://remote.example.com' }, user: {} }],
  });
  assert.equal(preview.fields[0].status, 'changed');
  assert.equal(preview.fields[0].conflict, false);
  assert.equal(preview.requiresConfirmation, false);
});
