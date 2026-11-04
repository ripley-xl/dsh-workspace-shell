import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { connectResolvedSsh } from '../../../packages/shell/ssh-remote/src/host/ssh/connection.js';
import { SshRemoteError } from '../../../packages/shell/ssh-remote/src/host/ssh/errors.js';
import {
  openProxyCommandTransport,
  openProxyJumpTransport,
} from '../../../packages/shell/ssh-remote/src/host/ssh/proxy.js';
import { baseConfig, FakeClient, wireKey } from '../../p0/transport/helpers.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => callback(),
    });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('exit', 0, signal));
  }
}

function spawnedChild() {
  const child = new FakeChild();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('ProxyCommand spawns argv without a shell and closes the process', async () => {
  const child = spawnedChild();
  let invocation;
  const transport = await openProxyCommandTransport({
    proxyCommand: ['proxy-tool', 'target.invalid', '22'],
  }, {
    spawn(file, args, options) {
      invocation = { args, file, options };
      return child;
    },
  });
  assert.equal(invocation.file, 'proxy-tool');
  assert.deepEqual(invocation.args, ['target.invalid', '22']);
  assert.equal(invocation.options.shell, false);
  await transport.close();
  assert.equal(transport.stream.destroyed, true);
  assert.equal(child.kills[0], 'SIGTERM');
});

test('cancelling ProxyCommand before spawn kills the child', async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const opening = openProxyCommandTransport({ proxyCommand: ['proxy-tool'] }, {
    signal: controller.signal,
    spawn: () => child,
  });
  controller.abort();
  await assert.rejects(opening, { code: 'OPERATION_CANCELLED' });
  assert.equal(child.kills[0], 'SIGTERM');
});

test('ProxyJump transport uses a bounded direct-tcpip request and cancels late channels', async () => {
  const controller = new AbortController();
  let callback;
  const client = {
    forwardOut(sourceHost, sourcePort, targetHost, targetPort, forwardCallback) {
      assert.equal(sourceHost, '127.0.0.1');
      assert.equal(sourcePort, 0);
      assert.equal(targetHost, 'target.invalid');
      assert.equal(targetPort, 2222);
      callback = forwardCallback;
    },
  };
  const opening = openProxyJumpTransport(client, {
    hostname: 'target.invalid',
    port: 2222,
  }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(opening, { code: 'OPERATION_CANCELLED' });
  const channel = new PassThrough();
  callback(null, channel);
  assert.equal(channel.destroyed, true);
});

function passwordClient(name, events) {
  const client = new FakeClient((options, current) => {
    queueMicrotask(() => {
      options.hostVerifier(wireKey(), (verified) => {
        if (!verified) {
          current.emit('error', new Error('host key rejected'));
          return;
        }
        options.authHandler(['password'], null, () => {
          events.push(`authenticated:${name}`);
          current.emit('ready');
        });
      });
    });
  });
  return client;
}

function proxyTestConfig(overrides = {}) {
  return baseConfig({
    alias: 'target',
    hostname: 'target.test.invalid',
    identityAgent: null,
    identityFiles: [],
    proxyJump: { alias: 'jump' },
    ...overrides,
  });
}

test('target close owns and closes the verified ProxyJump connection', async () => {
  const events = [];
  const jump = passwordClient('jump', events);
  const target = passwordClient('target', events);
  jump.forwardOut = (sourceHost, sourcePort, targetHost, targetPort, callback) => {
    events.push(`forward:${targetHost}:${targetPort}`);
    callback(null, new PassThrough());
  };
  const jumpConfig = proxyTestConfig({
    alias: 'jump',
    hostname: 'jump.test.invalid',
    proxyJump: null,
  });
  const clients = [target, jump];
  const channel = await connectResolvedSsh(proxyTestConfig(), {
    authCallbacks: { password: async () => 'test-password' },
    clientFactory: () => clients.shift(),
    hostKeyVerifier: async () => ({}),
    interactive: true,
    resolveSshConfig: async (alias) => {
      assert.equal(alias, 'jump');
      return jumpConfig;
    },
  });
  assert.deepEqual(events, [
    'authenticated:jump',
    'forward:target.test.invalid:22',
    'authenticated:target',
  ]);
  assert.equal(jump.options.agentForward, false);
  assert.equal(target.options.agentForward, false);
  await channel.close();
  assert.equal(jump.ended, true);
  assert.equal(jump.destroyed, true);
  assert.equal(target.destroyed, true);
});

test('target host key rejection closes ProxyJump before target authentication', async () => {
  const events = [];
  const jump = passwordClient('jump', events);
  const target = passwordClient('target', events);
  jump.forwardOut = (sourceHost, sourcePort, targetHost, targetPort, callback) => {
    callback(null, new PassThrough());
  };
  const clients = [target, jump];
  await assert.rejects(connectResolvedSsh(proxyTestConfig(), {
    authCallbacks: { password: async () => 'test-password' },
    clientFactory: () => clients.shift(),
    hostKeyVerifier: async (key, options) => {
      if (options.hostname === 'target.test.invalid') {
        throw new SshRemoteError('SSH_HOST_KEY_CHANGED', 'changed');
      }
      return {};
    },
    interactive: true,
    resolveSshConfig: async () => proxyTestConfig({
      alias: 'jump',
      hostname: 'jump.test.invalid',
      proxyJump: null,
    }),
  }), { code: 'SSH_HOST_KEY_CHANGED' });
  assert.deepEqual(events, ['authenticated:jump']);
  assert.equal(jump.destroyed, true);
  assert.equal(target.destroyed, true);
});

test('background authentication does not spawn ProxyCommand', async () => {
  await assert.rejects(connectResolvedSsh(proxyTestConfig({
    proxyCommand: ['proxy-tool'],
    proxyJump: null,
  }), {
    authCallbacks: { password: async () => 'must-not-be-used' },
    background: true,
    interactive: true,
    spawn: () => {
      throw new Error('ProxyCommand must not start');
    },
  }), { code: 'SSH_AUTH_INTERACTION_REQUIRED' });
});

test('target host key rejection closes the ProxyCommand process', async () => {
  const child = new FakeChild();
  const target = new FakeClient((options, current) => {
    queueMicrotask(() => {
      options.hostVerifier(wireKey(), () => current.emit('error', new Error('rejected')));
    });
  });
  let passwordCallbacks = 0;
  await assert.rejects(connectResolvedSsh(proxyTestConfig({
    proxyCommand: ['proxy-tool'],
    proxyJump: null,
  }), {
    authCallbacks: {
      password: async () => {
        passwordCallbacks += 1;
        return 'must-not-be-used';
      },
    },
    clientFactory: () => target,
    hostKeyVerifier: async () => {
      throw new SshRemoteError('SSH_HOST_KEY_CHANGED', 'changed');
    },
    interactive: true,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  }), { code: 'SSH_HOST_KEY_CHANGED' });
  assert.equal(passwordCallbacks, 0);
  assert.equal(target.destroyed, true);
  assert.equal(child.kills[0], 'SIGTERM');
});

test('ProxyJump loops fail before opening a connection', async () => {
  await assert.rejects(connectResolvedSsh(proxyTestConfig({
    proxyJump: { alias: 'target' },
  }), {
    authCallbacks: { password: async () => 'unused' },
    clientFactory: () => new FakeClient(),
    interactive: true,
  }), { code: 'SSH_CONFIG_INVALID' });
});
