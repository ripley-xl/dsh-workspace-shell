import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapRemoteRuntime } from '../../../packages/shell/ssh-remote/src/host/remote-controller.js';

function fakeChannel() {
  const execs = [];
  const uploads = [];
  const jsonCalls = [];
  return {
    execs,
    uploads,
    jsonCalls,
    async exec(request) {
      execs.push(request);
      return { code: 0, stdout: request.command === 'printenv' ? '/home/test\n' : '', stderr: '' };
    },
    async upload(localPath, remotePath) {
      uploads.push({ localPath, remotePath });
    },
    async execJson(request) {
      jsonCalls.push(request);
      return {
        ok: true,
        result: {
          path: '/home/test/.dsh/ssh-remote/servers/0.2.1-rc.5-controller-0.1.0-linux-x64-glibc',
          runtime: { dshVersion: '0.2.1-rc.5', buildId: 'npm:0.2.1-rc.5', installMode: 'npm' },
          alreadyInstalled: false,
        },
      };
    },
  };
}

test('bootstrap uploads the controller and plugins, then installs DSH with npm on the remote', async () => {
  const channel = fakeChannel();
  const installed = await bootstrapRemoteRuntime(channel, { version: '0.2.1-rc.5' });
  assert.deepEqual(installed.runtime, { dshVersion: '0.2.1-rc.5', buildId: 'npm:0.2.1-rc.5', installMode: 'npm' });
  assert.match(installed.executable, /\/bin\/dsh-ssh-remote-controller$/u);
  const remotePaths = channel.uploads.map((entry) => entry.remotePath);
  assert.ok(remotePaths.some((value) => value.endsWith('/controller/src/cli.js')), 'controller sources upload');
  assert.ok(remotePaths.some((value) => value.endsWith('/plugins/status/index.js')), 'status plugin uploads');
  assert.ok(remotePaths.some((value) => value.endsWith('/plugins/guest-cwd/index.js')), 'guest-cwd plugin uploads');
  assert.equal(remotePaths.some((value) => value.includes('/node_modules/')), false);
  assert.equal(channel.jsonCalls.length, 1);
  const call = channel.jsonCalls[0];
  assert.equal(call.command, 'node');
  assert.ok(call.args.some((value) => value.endsWith('/controller/src/cli.js')));
  const joined = call.args.join(' ');
  assert.match(joined, /install --mode npm --dsh-version 0\.2\.1-rc\.5/u);
  assert.match(joined, /--controller-source /u);
  assert.match(joined, /--plugins-source /u);
  assert.match(joined, /--root \/home\/test\/\.dsh\/ssh-remote/u);
  assert.equal(channel.execs.some((request) => request.command === 'tar'), false);
  const cleanup = channel.execs.at(-1);
  assert.equal(cleanup.command, 'rm');
  assert.equal(cleanup.args[0], '-rf');
});

test('bootstrap surfaces a remote install failure with the controller code', async () => {
  const channel = fakeChannel();
  channel.execJson = async () => ({ ok: false, error: { code: 'REMOTE_NODE_MISSING', message: 'Node.js is not installed on the remote host.' } });
  await assert.rejects(bootstrapRemoteRuntime(channel, { version: '0.2.1-rc.5' }), (error) => error.code === 'REMOTE_NODE_MISSING' && /Node\.js/u.test(error.message));
});
