import assert from 'node:assert/strict';
import test from 'node:test';

import { probeRemoteTarget } from '../../../packages/shell/ssh-remote/src/host/target-probe.js';
import { buildSyncInput } from '../../../packages/shell/ssh-remote/src/host/sync-input.js';

test('remote target probe uses fixed commands and normalizes Linux architecture and libc', async () => {
  const commands = [];
  const channel = {
    async exec(request) {
      commands.push(request);
      if (request.command === 'uname' && request.args[0] === '-s') return { code: 0, stdout: 'Linux\n', stderr: '' };
      if (request.command === 'uname') return { code: 0, stdout: 'aarch64\n', stderr: '' };
      return { code: 0, stdout: 'musl libc (aarch64)\n', stderr: '' };
    },
  };
  assert.deepEqual(await probeRemoteTarget(channel), { platform: 'linux', arch: 'arm64', libc: 'musl' });
  assert.deepEqual(commands.map((request) => [request.command, ...request.args]), [['uname', '-s'], ['uname', '-m'], ['ldd', '--version']]);
  assert.ok(commands.every((request) => request.timeoutMs === 5_000));
});

test('sync input uses saved policy, strips secret settings and resolves only authorized refs', async () => {
  const resolved = [];
  const input = await buildSyncInput({
    pluginTemplate: [
      { spec: 'dsh-workspace-shell-status' },
      { name: '@local/example', spec: '@local/example', version: '1.0.0', approvedBuilds: ['example'], settingsNamespaces: ['example'] },
    ],
    syncPolicy: { appearance: true, modelNamespaces: ['model'], credentialRefs: ['TEST_KEY'] },
  }, {
    descriptors: [
      { ns: 'ui-theme', value: { preference: 'dark' } },
      { ns: 'model', value: { baseURL: 'https://example.com', apiKey: 'not-copied' }, schema: { properties: { apiKey: { credentialRef: 'TEST_KEY' } } }, secrets: [{ path: ['apiKey'], set: true }] },
      { ns: 'example', value: { enabled: true } },
    ],
    resolveCredential: async (ref) => {
      resolved.push(ref);
      return { value: 'secret-api-key', source: 'test' };
    },
  });
  assert.deepEqual(resolved, ['TEST_KEY']);
  assert.deepEqual(input.credentials, [{ ref: 'TEST_KEY', value: 'secret-api-key' }]);
  assert.deepEqual(input.settings.find((setting) => setting.ns === 'model').patch, { baseURL: 'https://example.com' });
  assert.equal(input.plugins.length, 1);
  assert.equal(input.plugins[0].spec, '@local/example@1.0.0');
  assert.equal(input.plugins[0].approvedBuilds[0], 'example');
});

test('sync input rejects conflicting plugin spec and version fields', async () => {
  await assert.rejects(buildSyncInput({
    pluginTemplate: [{ spec: '@local/example@1.0.0', version: '2.0.0' }],
    syncPolicy: { appearance: false, modelNamespaces: [], credentialRefs: [] },
  }, { descriptors: [], resolveCredential: async () => undefined }), (error) => error.code === 'PLUGIN_TEMPLATE_PARTIAL');
});
