import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSyncInput, discoverCredentialRefs } from '../../../packages/manager/src/host/sync-input.js';

const DEEPSEEK_SCHEMA = {
  type: 'object',
  properties: {
    baseURL: { type: 'string' },
    thinking: { type: 'string' },
    models: { type: 'array' },
    apiKeyEnv: { default: 'DEEPSEEK_API_KEY', type: 'string', 'x-cordis': { role: 'credential-ref', volatile: true } },
    currentCwd: { type: 'string' },
    cacheFile: { type: 'string' },
    localEndpoint: { type: 'string' },
    accountOperations: { type: 'array', 'x-cordis': { hidden: true } },
    apiToken: { type: 'string' },
  },
};
const OPENCODE_SCHEMA = {
  type: 'object',
  properties: {
    accounts: {
      type: 'array',
      items: { type: 'object', properties: { apiKeyEnv: { type: 'string', 'x-cordis': { role: 'credential-ref' } } } },
    },
  },
};

function descriptors() {
  return [
    {
      ns: 'include:llm-deepseek', autoGenerate: false, applies: 'live', revision: 4,
      schema: DEEPSEEK_SCHEMA,
      value: {
        baseURL: 'https://api.deepseek.com', thinking: 'enabled', models: [{ id: 'default-model' }],
        apiKeyEnv: 'DEEPSEEK_API_KEY', currentCwd: '/Users/local/project', cacheFile: 'file:///tmp/cache',
        accountOperations: [{ id: 'runtime-operation' }], apiToken: 'secret-token',
      },
      user: {
        baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', currentCwd: '/Users/local/project',
        cacheFile: 'file:///tmp/cache', localEndpoint: 'http://127.0.0.1:11434/v1', accountOperations: [{ id: 'runtime-operation' }], apiToken: 'secret-token',
      },
      secrets: [{ path: ['apiToken'], set: true }],
    },
    {
      ns: 'include:opencode-go', schema: OPENCODE_SCHEMA,
      value: { accounts: [{ id: 'alt', apiKeyEnv: 'OPENCODE_ALT_KEY' }] },
      user: { accounts: [{ id: 'alt', apiKeyEnv: 'OPENCODE_ALT_KEY' }] },
    },
    { ns: 'include:ui-theme', schema: { properties: { preference: { type: 'string' } } }, value: { preference: 'dark', fontSize: 14 }, user: { preference: 'dark' } },
    { ns: 'include:working-directory', schema: {}, value: { cwd: '/Users/local/project' }, user: { cwd: '/Users/local/project' } },
    { ns: 'include:storage-json', schema: {}, value: { path: '/Users/local/.dsh/store.json' }, user: { path: '/Users/local/.dsh/store.json' } },
    { ns: 'include:plugin-manager', schema: {}, value: { registry: 'https://registry.example' }, user: { registry: 'https://registry.example' } },
  ];
}

test('allSupported traverses supported user settings and real credential schema declarations', async () => {
  const values = descriptors();
  assert.deepEqual(discoverCredentialRefs(values), ['DEEPSEEK_API_KEY', 'OPENCODE_ALT_KEY']);
  const resolved = [];
  const input = await buildSyncInput({
    syncPolicy: { allSupported: true, appearance: false, modelNamespaces: ['ignored'], credentialRefs: ['LEGACY_KEY'] },
  }, {
    descriptors: values,
    credentialDescriptors: {
      DEEPSEEK_API_KEY: { configured: true, writable: true },
      OPENCODE_ALT_KEY: { configured: false, writable: true },
    },
    resolveCredential: async (ref) => { resolved.push(ref); return { value: `secret-${ref}` }; },
  });
  const deepseek = input.settings.find((setting) => setting.ns === 'include:llm-deepseek');
  assert.deepEqual(deepseek.patch, { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' });
  assert.equal('models' in deepseek.patch, false);
  assert.equal('thinking' in deepseek.patch, false);
  assert.equal('currentCwd' in deepseek.patch, false);
  assert.equal('cacheFile' in deepseek.patch, false);
  assert.equal('localEndpoint' in deepseek.patch, false);
  assert.equal('accountOperations' in deepseek.patch, false);
  assert.equal('apiToken' in deepseek.patch, false);
  assert.equal(input.settings.some((setting) => setting.ns.includes('working-directory')), false);
  assert.equal(input.settings.some((setting) => setting.ns.includes('storage-json')), false);
  assert.equal(input.settings.some((setting) => setting.ns.includes('plugin-manager')), false);
  assert.deepEqual(input.credentials, [{ ref: 'DEEPSEEK_API_KEY', value: 'secret-DEEPSEEK_API_KEY' }]);
  assert.deepEqual(resolved, ['DEEPSEEK_API_KEY']);
});

test('preview discovers configured refs with describe only and allSupported=false disables settings and credentials', async () => {
  const values = descriptors();
  let resolveCalled = false;
  const preview = await buildSyncInput({ syncPolicy: { allSupported: true } }, {
    descriptors: values,
    includeCredentialValues: false,
    credentialDescriptors: { DEEPSEEK_API_KEY: { configured: true }, OPENCODE_ALT_KEY: { configured: false } },
    resolveCredential: async () => { resolveCalled = true; },
  });
  assert.deepEqual(preview.credentials, [{ ref: 'DEEPSEEK_API_KEY' }]);
  assert.equal(resolveCalled, false);
  const disabled = await buildSyncInput({
    syncPolicy: { allSupported: false, appearance: true, modelNamespaces: ['include:ui-theme'], credentialRefs: ['DEEPSEEK_API_KEY'] },
  }, { descriptors: values, resolveCredential: async () => { throw new Error('must not resolve'); } });
  assert.deepEqual(disabled.settings, []);
  assert.deepEqual(disabled.credentials, []);
});

test('legacy records default to allSupported and ignore legacy namespace/ref selections', async () => {
  const input = await buildSyncInput({
    syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: ['LEGACY_KEY'] },
  }, {
    descriptors: descriptors(), includeCredentialValues: false,
    credentialDescriptors: { DEEPSEEK_API_KEY: { configured: true }, OPENCODE_ALT_KEY: { configured: true } },
  });
  assert.deepEqual(input.credentialRefs, ['DEEPSEEK_API_KEY', 'OPENCODE_ALT_KEY']);
  assert.equal(input.credentials.some((credential) => credential.ref === 'LEGACY_KEY'), false);
  assert.equal(input.settings.some((setting) => setting.ns === 'include:ui-theme'), true);
});
