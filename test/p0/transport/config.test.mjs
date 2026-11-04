import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  parseSshGOutput,
  resolveSshConfig,
  splitSshConfigWords,
} from '../../../packages/manager/src/host/ssh/config.js';

const options = {
  cwd: '/work',
  env: { SSH_AUTH_SOCK: '/tmp/agent.sock', USER: 'local-user' },
  homeDir: '/home/local-user',
  localUser: 'local-user',
};

const minimumOutput = `
host unit
user tester
hostname unit.test.invalid
port 22
stricthostkeychecking yes
userknownhostsfile ~/.ssh/known_hosts
globalknownhostsfile /etc/ssh/ssh_known_hosts
`;

test('parseSshGOutput resolves supported fields and repeated identity files', () => {
  const config = parseSshGOutput('unit', `
host unit
user alice
hostname example.internal
port 2222
identityfile "~/keys/id one"
identityfile ~/.keys/id_two
identityagent $SSH_AUTH_SOCK
hostkeyalias key-%h
stricthostkeychecking accept-new
userknownhostsfile "~/known hosts" ~/.ssh/known_hosts2
globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2
proxyjump none
proxycommand none
`, options);

  assert.equal(config.hostname, 'example.internal');
  assert.equal(config.user, 'alice');
  assert.equal(config.port, 2222);
  assert.deepEqual(config.identityFiles, [
    '/home/local-user/keys/id one',
    '/home/local-user/.keys/id_two',
  ]);
  assert.equal(config.identityAgent, '/tmp/agent.sock');
  assert.equal(config.hostKeyAlias, 'key-example.internal');
  assert.equal(config.strictHostKeyChecking, 'accept-new');
  assert.deepEqual(config.userKnownHostsFiles, [
    '/home/local-user/known hosts',
    '/home/local-user/.ssh/known_hosts2',
  ]);
  assert.deepEqual(config.globalKnownHostsFiles, [
    '/etc/ssh/ssh_known_hosts',
    '/etc/ssh/ssh_known_hosts2',
  ]);
});

test('splitSshConfigWords preserves quoted paths', () => {
  assert.deepEqual(
    splitSshConfigWords('"~/known hosts" /etc/ssh/known\\ hosts'),
    ['~/known hosts', '/etc/ssh/known hosts'],
  );
});

for (const [field, value] of [['proxyjump', 'bastion'], ['proxycommand', 'nc %h %p']]) {
  test(`rejects configured ${field}`, () => {
    assert.throws(
      () => parseSshGOutput('unit', `${minimumOutput}${field} ${value}\n`, options),
      { code: 'SSH_UNSUPPORTED_CONFIG' },
    );
  });
}

for (const value of ['no', 'off']) {
  test(`rejects StrictHostKeyChecking=${value}`, () => {
    assert.throws(
      () => parseSshGOutput(
        'unit',
        minimumOutput.replace('stricthostkeychecking yes', `stricthostkeychecking ${value}`),
        options,
      ),
      { code: 'SSH_UNSUPPORTED_CONFIG' },
    );
  });
}

test('rejects invalid ports and unsafe aliases', () => {
  assert.throws(
    () => parseSshGOutput('unit', minimumOutput.replace('port 22', 'port 70000'), options),
    { code: 'SSH_CONFIG_INVALID' },
  );
  assert.throws(() => parseSshGOutput('-oProxyCommand=x', minimumOutput, options), {
    code: 'SSH_CONFIG_INVALID',
  });
});

test('resolveSshConfig uses ssh -G without a shell or network connection', async () => {
  let invocation;
  const config = await resolveSshConfig('unit', {
    ...options,
    execFile(file, args, execOptions, callback) {
      invocation = { args, execOptions, file };
      callback(null, minimumOutput);
    },
  });
  assert.equal(invocation.file, 'ssh');
  assert.deepEqual(invocation.args, ['-G', '--', 'unit']);
  assert.equal(invocation.execOptions.timeout, 10_000);
  assert.equal(config.alias, 'unit');
  assert.equal(config.userKnownHostsFiles[0], path.join(options.homeDir, '.ssh/known_hosts'));
});

test('resolveSshConfig classifies cancellation and timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveSshConfig('unit', {
    signal: controller.signal,
    execFile() {
      throw new Error('must not execute');
    },
  }), { code: 'OPERATION_CANCELLED' });

  await assert.rejects(resolveSshConfig('unit', {
    execFile(file, args, execOptions, callback) {
      callback(Object.assign(new Error('killed'), { killed: true }));
    },
  }), { code: 'OPERATION_TIMEOUT' });
});
