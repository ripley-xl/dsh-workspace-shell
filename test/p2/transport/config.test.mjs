import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProxyJump,
  parseSshGOutput,
} from '../../../packages/manager/src/host/ssh/config.js';

const baseOutput = `
host target
user alice
hostname target.test.invalid
port 2222
stricthostkeychecking yes
userknownhostsfile ~/.ssh/known_hosts
globalknownhostsfile /etc/ssh/ssh_known_hosts
`;

const options = {
  homeDir: '/home/local',
  localUser: 'local',
  proxySupport: true,
};

test('ProxyCommand becomes direct argv with expanded OpenSSH tokens', () => {
  const config = parseSshGOutput('target', `${baseOutput}proxycommand limactl shell "vm name" -- nc %h %p %%\n`, options);
  assert.deepEqual(config.proxyCommand, [
    'limactl',
    'shell',
    'vm name',
    '--',
    'nc',
    'target.test.invalid',
    '2222',
    '%',
  ]);
  assert.equal(config.proxyJump, null);
});

test('ProxyJump supports a single alias with optional user and port', () => {
  const config = parseSshGOutput('target', `${baseOutput}proxyjump bob@bastion.test:2200\n`, options);
  assert.deepEqual(config.proxyJump, {
    alias: 'bastion.test',
    port: 2200,
    user: 'bob',
  });
  assert.equal(config.proxyCommand, null);
  assert.deepEqual(parseProxyJump('jump-alias'), {
    alias: 'jump-alias',
    port: undefined,
    user: undefined,
  });
  assert.deepEqual(parseProxyJump('bob@[::1]:2222'), {
    alias: '::1',
    port: 2222,
    user: 'bob',
  });
});

test('ambiguous or multi-hop proxy configuration is rejected', () => {
  assert.throws(
    () => parseSshGOutput('target', `${baseOutput}proxyjump one,two\n`, options),
    { code: 'SSH_UNSUPPORTED_CONFIG' },
  );
  assert.throws(
    () => parseSshGOutput('target', `${baseOutput}proxyjump bastion\nproxycommand nc %h %p\n`, options),
    { code: 'SSH_CONFIG_INVALID' },
  );
  assert.throws(() => parseProxyJump('user@host:70000'), { code: 'SSH_CONFIG_INVALID' });
});
