import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { connectResolvedSsh } from '../../../packages/manager/src/host/ssh/connection.js';
import { baseConfig, FakeClient, wireKey } from '../../p0/transport/helpers.mjs';

const encryptedKeyError = () => new Error('Encrypted private OpenSSH key detected, but no passphrase given');

function interactiveConfig(overrides = {}) {
  return baseConfig({
    identityAgent: null,
    identityFiles: [],
    ...overrides,
  });
}

function authClient(method, events, onNext) {
  return new FakeClient((options, client) => {
    queueMicrotask(() => {
      options.hostVerifier(wireKey(), () => {
        events.push('host-key');
        options.authHandler([method], null, (next) => {
          events.push('next');
          onNext(next, client, options);
        });
      });
    });
  });
}

test('password callback runs after host verification and user time is not network time', async () => {
  const events = [];
  let passwordAtUse;
  const client = authClient('password', events, (next, current, options) => {
    passwordAtUse = next.password.toString();
    assert.equal(options.agentForward, false);
    assert.equal(options.password, undefined);
    current.emit('ready');
  });
  const channel = await connectResolvedSsh(interactiveConfig(), {
    authCallbacks: {
      password: async (context) => {
        events.push(`callback:${context.kind}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'test-password';
      },
    },
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
    interactionTimeoutMs: 1000,
    readyTimeoutMs: 5,
  });
  assert.deepEqual(events, ['host-key', 'callback:password', 'next']);
  assert.equal(passwordAtUse, 'test-password');
  assert.equal(JSON.stringify(channel.config).includes('test-password'), false);
  await channel.close();
});

test('background and non-interactive connections never invoke secret callbacks', async () => {
  let calls = 0;
  const authCallbacks = {
    password: async () => {
      calls += 1;
      return 'must-not-be-used';
    },
  };
  for (const options of [{ background: true, interactive: true }, { interactive: false }]) {
    await assert.rejects(connectResolvedSsh(interactiveConfig(), {
      ...options,
      authCallbacks,
      clientFactory: () => {
        throw new Error('no client should be created');
      },
    }), { code: 'SSH_AUTH_INTERACTION_REQUIRED' });
  }
  assert.equal(calls, 0);
});

test('interaction timeout is distinct from network timeout', async () => {
  const waiting = authClient('password', [], () => {});
  await assert.rejects(connectResolvedSsh(interactiveConfig(), {
    authCallbacks: { password: async () => new Promise(() => {}) },
    clientFactory: () => waiting,
    hostKeyVerifier: async () => ({}),
    interactive: true,
    interactionTimeoutMs: 5,
    readyTimeoutMs: 1000,
  }), { code: 'SSH_AUTH_INTERACTION_TIMEOUT' });
  assert.equal(waiting.destroyed, true);

  const network = new FakeClient();
  await assert.rejects(connectResolvedSsh(interactiveConfig(), {
    authCallbacks: { password: async () => 'unused' },
    clientFactory: () => network,
    interactive: true,
    readyTimeoutMs: 5,
  }), { code: 'OPERATION_TIMEOUT' });
});

test('cancelling a pending secret callback closes SSH and clears a late Buffer', async () => {
  const controller = new AbortController();
  let answer;
  const secret = Buffer.from('late-secret');
  const client = authClient('password', [], () => {});
  const connecting = connectResolvedSsh(interactiveConfig(), {
    authCallbacks: {
      password: () => new Promise((resolve) => {
        answer = resolve;
      }),
    },
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(connecting, { code: 'OPERATION_CANCELLED' });
  answer(secret);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(secret, Buffer.alloc(secret.length));
  assert.equal(client.destroyed, true);
});

test('encrypted private key requests passphrase only after host verification', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p2-key-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const identityFile = path.join(directory, 'id_ed25519');
  await fs.writeFile(identityFile, 'encrypted fixture', { mode: 0o600 });
  const events = [];
  let passphraseAtUse;
  const client = authClient('publickey', events, (next, current, options) => {
    passphraseAtUse = next.passphrase.toString();
    assert.equal(options.privateKey, undefined);
    assert.equal(options.passphrase, undefined);
    current.emit('ready');
  });
  const channel = await connectResolvedSsh(interactiveConfig({ identityFiles: [identityFile] }), {
    authCallbacks: {
      passphrase: async (context) => {
        events.push(`callback:${context.kind}`);
        assert.equal(context.identityFile, identityFile);
        return 'test-passphrase';
      },
    },
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
    keyParser: encryptedKeyError,
  });
  assert.deepEqual(events, ['host-key', 'callback:passphrase', 'next']);
  assert.equal(passphraseAtUse, 'test-passphrase');
  await channel.close();
});

test('encrypted private key in background fails instead of prompting', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p2-key-background-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const identityFile = path.join(directory, 'id_ed25519');
  await fs.writeFile(identityFile, 'encrypted fixture', { mode: 0o600 });
  let callbacks = 0;
  const client = authClient('publickey', [], () => {});
  await assert.rejects(connectResolvedSsh(interactiveConfig({ identityFiles: [identityFile] }), {
    authCallbacks: {
      passphrase: async () => {
        callbacks += 1;
        return 'must-not-be-used';
      },
    },
    background: true,
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
    keyParser: encryptedKeyError,
  }), { code: 'SSH_AUTH_INTERACTION_REQUIRED' });
  assert.equal(callbacks, 0);
  assert.equal(client.destroyed, true);
});

test('keyboard-interactive forwards prompt metadata and string answers', async () => {
  const events = [];
  let callbackContext;
  const client = authClient('keyboard-interactive', events, (next, current) => {
    next.prompt(
      'SSH login',
      'Enter your test password',
      '',
      [{ echo: false, prompt: 'Password: ' }],
      (answers) => {
        assert.deepEqual(answers, ['keyboard-secret']);
        current.emit('ready');
      },
    );
  });
  const channel = await connectResolvedSsh(interactiveConfig(), {
    authCallbacks: {
      keyboardInteractive: async (context) => {
        callbackContext = context;
        return ['keyboard-secret'];
      },
    },
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
  });
  assert.equal(callbackContext.kind, 'keyboardInteractive');
  assert.equal(callbackContext.name, 'SSH login');
  assert.equal(callbackContext.instructions, 'Enter your test password');
  assert.deepEqual(callbackContext.prompts, [{ echo: false, prompt: 'Password: ' }]);
  assert.equal(JSON.stringify(channel.config).includes('keyboard-secret'), false);
  await channel.close();
});

test('authentication callback validation never echoes secrets in errors', async () => {
  const client = authClient('password', [], () => {});
  await assert.rejects(connectResolvedSsh(interactiveConfig(), {
    authCallbacks: {
      password: async () => {
        throw new Error('sensitive callback failure');
      },
    },
    clientFactory: () => client,
    hostKeyVerifier: async () => ({}),
    interactive: true,
  }), (error) => {
    assert.equal(error.code, 'SSH_AUTH_INTERACTION_FAILED');
    assert.equal(error.message.includes('sensitive'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
