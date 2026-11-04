import assert from 'node:assert/strict';
import test from 'node:test';
import { findInstalledRemoteRuntime, RemoteControllerClient } from '../../packages/shell/ssh-remote/src/host/remote-controller.js';

test('controller adapter correlates requests and returns the command result', async () => {
  let request;
  const channel = {
    async execJson(value) {
      request = value;
      return { protocolVersion: value.protocolVersion, requestId: value.requestId, ok: true, result: { instances: [] } };
    },
  };
  const controller = new RemoteControllerClient({
    channel,
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  const result = await controller.list({ version: '0.2.1-rc.5', buildId: 'build-1' });
  assert.deepEqual(result, { instances: [] });
  assert.deepEqual(request.args.slice(0, 5), ['list', '--expected-version', '0.2.1-rc.5', '--expected-build-id', 'build-1']);
  assert.deepEqual(request.args.slice(-2), ['--request-id', request.requestId]);
});

test('controller adapter preserves structured remote failures', async () => {
  const controller = new RemoteControllerClient({
    channel: {
      async execJson(value) {
        return { protocolVersion: 1, requestId: value.requestId, ok: false, error: { code: 'REMOTE_VERSION_MISMATCH', message: 'version mismatch' } };
      },
    },
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  await assert.rejects(controller.list(), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
});

test('installed runtime lookup validates the npm receipt before skipping upload', async () => {
  const commands = [];
  const recipes = new Map([
    ['install-receipt.json', { installMode: 'npm' }],
    ['manifest.json', { runtimeId: 'runtime-1', dshVersion: '0.2.1-rc.5', buildId: 'npm:0.2.1-rc.5' }],
  ]);
  const channel = {
    async exec(request) {
      commands.push(request);
      if (request.command === 'printenv') return { code: 0, stdout: '/home/test\n' };
      if (request.command === 'test') return { code: 0, stdout: '' };
      if (request.command === 'cat') {
        const name = request.args[0].split('/').pop();
        const value = recipes.get(name);
        return value === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify(value) };
      }
      throw new Error(`unexpected command: ${request.command}`);
    },
  };
  const installed = await findInstalledRemoteRuntime(channel, {
    runtimeId: 'runtime-1', version: '0.2.1-rc.5', buildId: 'npm:0.2.1-rc.5',
  });
  assert.equal(installed.home, '/home/test');
  assert.equal(installed.alreadyInstalled, true);
  assert.equal(commands.some((request) => request.command === 'tar'), false);
  recipes.set('install-receipt.json', { installMode: 'archive', sha256: 'digest-1' });
  const legacy = await findInstalledRemoteRuntime(channel, {
    runtimeId: 'runtime-1', version: '0.2.1-rc.5', buildId: 'npm:0.2.1-rc.5',
  });
  assert.equal(legacy, null, 'archived runtimes are not reused by the npm flow');
});
