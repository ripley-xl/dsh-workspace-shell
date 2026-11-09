import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { connectResolvedSsh } from '../../../packages/manager/src/host/ssh/connection.js';
import { SshRemoteError } from '../../../packages/manager/src/host/ssh/errors.js';
import { baseConfig, FakeClient, wireKey } from './helpers.mjs';

function verifiedClient(events = [], key = wireKey()) {
  return new FakeClient((options, client) => {
    queueMicrotask(() => {
      options.hostVerifier(key, (verified) => {
        events.push(`host-key:${verified}`);
        if (!verified) {
          client.emit('error', new Error('host verification failed'));
          return;
        }
        events.push('authenticating');
        client.emit('ready');
      });
    });
  });
}

test('ssh2 connection disables interactive authentication and agent forwarding', async () => {
  const client = verifiedClient();
  const channel = await connectResolvedSsh(baseConfig(), {
    clientFactory: () => client,
    hostKeyVerifier: async () => ({ status: 'matched' }),
  });
  assert.equal(channel.client, client);
  assert.equal(client.options.agent, '/tmp/unit-test-agent.sock');
  assert.equal(client.options.agentForward, false);
  assert.equal(client.options.tryKeyboard, false);
  assert.equal(client.options.password, undefined);
  assert.equal(client.options.passphrase, undefined);
  await channel.close();
  assert.equal(client.ended, true);
  assert.equal(client.destroyed, true);
});

test('host key rejection closes the connection before authentication', async () => {
  const events = [];
  const client = verifiedClient(events);
  await assert.rejects(connectResolvedSsh(baseConfig(), {
    clientFactory: () => client,
    hostKeyVerifier: async () => {
      events.push('verifying');
      throw new SshRemoteError('SSH_HOST_KEY_CHANGED', 'changed');
    },
  }), { code: 'SSH_HOST_KEY_CHANGED' });
  assert.deepEqual(events, ['verifying', 'host-key:false']);
  assert.equal(client.destroyed, true);
});

test('background host key verification has no interactive trust path', async () => {
  const client = verifiedClient();
  let verificationOptions;
  await assert.rejects(connectResolvedSsh(baseConfig(), {
    background: true,
    interactive: true,
    clientFactory: () => client,
    hostKeyVerifier: async (key, options) => {
      verificationOptions = options;
      throw new SshRemoteError('SSH_HOST_KEY_UNKNOWN', 'unknown');
    },
  }), { code: 'SSH_HOST_KEY_UNKNOWN' });
  assert.equal(verificationOptions.interactive, false);
  assert.equal(client.destroyed, true);
});

test('authentication falls back from a failed agent to an unencrypted key', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-auth-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const identityFile = path.join(directory, 'id_ed25519');
  await fs.writeFile(identityFile, 'unencrypted test fixture', { mode: 0o600 });

  const clients = [
    new FakeClient((options, client) => queueMicrotask(() => {
      options.hostVerifier(wireKey(), () => {
        const error = new Error('agent denied');
        error.level = 'client-authentication';
        client.emit('error', error);
      });
    })),
    verifiedClient(),
  ];
  const channel = await connectResolvedSsh(baseConfig({ identityFiles: [identityFile] }), {
    clientFactory: () => clients.shift(),
    hostKeyVerifier: async () => ({ status: 'matched' }),
  });
  assert.ok(channel);
  assert.equal(channel.client.options.agent, undefined);
  assert.ok(Buffer.isBuffer(channel.client.options.privateKey));
  await channel.close();
});

test('cancelling an unfinished SSH connection closes the client', async () => {
  const client = new FakeClient();
  const controller = new AbortController();
  const connecting = connectResolvedSsh(baseConfig(), {
    clientFactory: () => client,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(connecting, { code: 'OPERATION_CANCELLED' });
  assert.equal(client.ended, true);
  assert.equal(client.destroyed, true);
});

test('transport failures use SSH_CONNECTION_FAILED', async () => {
  const client = new FakeClient((options, current) => {
    queueMicrotask(() => current.emit('error', Object.assign(new Error('network down'), { code: 'ECONNRESET' })));
  });
  await assert.rejects(connectResolvedSsh(baseConfig(), {
    clientFactory: () => client,
  }), { code: 'SSH_CONNECTION_FAILED' });
});

test('a connected channel closes its gateways with the SSH client', async () => {
  const client = verifiedClient();
  const channel = await connectResolvedSsh(baseConfig(), {
    clientFactory: () => client,
    hostKeyVerifier: async () => ({ status: 'matched' }),
  });
  const closed = once(channel, 'close');
  client.emit('close');
  await closed;
  assert.equal(channel.closed, true);
});
