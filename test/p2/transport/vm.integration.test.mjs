import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { connectResolvedSsh } from '../../../packages/manager/src/host/ssh/connection.js';
import { appendKnownHostKey } from '../../../packages/manager/src/host/ssh/known-hosts.js';
import { createIsolatedSshd, runVm, VM_NAME } from './vm-fixture.mjs';

const execute = promisify(execFile);
const enabled = process.env.DSH_SSH_REMOTE_P2_VM === '1';

function scalar(output, key) {
  const match = output.match(new RegExp(`^${key} (.+)$`, 'mu'));
  if (!match) throw new Error(`Missing ${key} in the Lima SSH configuration.`);
  return match[1];
}

async function recordHostKey(file, hostname, port, publicKey) {
  const [keyType, encodedKey] = publicKey.trim().split(/\s+/u);
  assert.equal(keyType, 'ssh-ed25519');
  await appendKnownHostKey(file, {
    hostname,
    key: Buffer.from(encodedKey, 'base64'),
    keyType,
    port,
  });
}

async function jumpConfig(knownHostsFile) {
  const name = VM_NAME;
  const configFile = path.join(os.homedir(), '.lima', name, 'ssh.config');
  const { stdout } = await execute('ssh', [
    '-G', '-F', configFile, `lima-${name}`,
  ], { encoding: 'utf8', timeout: 10_000 });
  const hostPublicKey = await runVm(['cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
  const hostname = scalar(stdout, 'hostname');
  const port = Number(scalar(stdout, 'port'));
  await recordHostKey(knownHostsFile, hostname, port, hostPublicKey.stdout);
  return {
    alias: 'p2-jump',
    globalKnownHostsFiles: [],
    hostname,
    identityAgent: null,
    identityFiles: [scalar(stdout, 'identityfile')],
    port,
    proxyCommand: null,
    proxyJump: null,
    strictHostKeyChecking: 'yes',
    user: scalar(stdout, 'user'),
    userKnownHostsFiles: [knownHostsFile],
  };
}

async function assertAuthenticated(channel, username) {
  const result = await channel.exec({ args: ['-un'], command: '/usr/bin/id' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), username);
  await channel.close();
}

const connectionOptions = {
  interactionTimeoutMs: 10_000,
  readyTimeoutMs: 15_000,
};

test('isolated VM P2 authentication and proxy chains', { skip: !enabled, timeout: 180_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p2-transport-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const fixture = await createIsolatedSshd();
  t.after(fixture.cleanup);

  const targetKnownHosts = path.join(directory, 'target_known_hosts');
  await recordHostKey(targetKnownHosts, '127.0.0.1', fixture.port, fixture.hostPublicKey);
  const encryptedKey = path.join(directory, 'id_ed25519');
  const passphrase = `P2-key-${process.pid}`;
  await execute('ssh-keygen', [
    '-q', '-t', 'ed25519', '-N', passphrase, '-f', encryptedKey,
  ], { timeout: 10_000 });
  await fixture.writeAuthorizedKey(await fs.readFile(`${encryptedKey}.pub`, 'utf8'));

  const proxyCommand = [
    'limactl', 'shell', VM_NAME, '--', 'nc', '127.0.0.1', String(fixture.port),
  ];
  const target = (overrides = {}) => ({
    alias: 'p2-target',
    globalKnownHostsFiles: [],
    hostname: '127.0.0.1',
    identityAgent: null,
    identityFiles: [],
    port: fixture.port,
    proxyCommand,
    proxyJump: null,
    strictHostKeyChecking: 'yes',
    user: fixture.username,
    userKnownHostsFiles: [targetKnownHosts],
    ...overrides,
  });

  await t.test('password callback', async () => {
    const channel = await connectResolvedSsh(target(), {
      ...connectionOptions,
      authCallbacks: {
        password: async (context) => {
          assert.equal(context.kind, 'password');
          return fixture.password;
        },
      },
      interactive: true,
    });
    await assertAuthenticated(channel, fixture.username);
  });

  await t.test('keyboard-interactive callback', async () => {
    let prompts;
    const channel = await connectResolvedSsh(target(), {
      ...connectionOptions,
      authCallbacks: {
        keyboardInteractive: async (context) => {
          assert.equal(context.kind, 'keyboardInteractive');
          prompts = context.prompts;
          return context.prompts.map(() => fixture.password);
        },
      },
      interactive: true,
    });
    assert.ok(prompts.length > 0);
    await assertAuthenticated(channel, fixture.username);
  });

  await t.test('encrypted private key passphrase callback', async () => {
    const channel = await connectResolvedSsh(target({ identityFiles: [encryptedKey] }), {
      ...connectionOptions,
      authCallbacks: {
        passphrase: async (context) => {
          assert.equal(context.kind, 'passphrase');
          return passphrase;
        },
      },
      interactive: true,
    });
    await assertAuthenticated(channel, fixture.username);
  });

  await t.test('ProxyJump through the VM main sshd', async () => {
    const knownHosts = path.join(directory, 'jump_known_hosts');
    const resolvedJump = await jumpConfig(knownHosts);
    const channel = await connectResolvedSsh(target({
      proxyCommand: null,
      proxyJump: { alias: 'p2-jump' },
    }), {
      ...connectionOptions,
      authCallbacks: { password: async () => fixture.password },
      interactive: true,
      resolveSshConfig: async (alias) => {
        assert.equal(alias, 'p2-jump');
        return resolvedJump;
      },
    });
    await assertAuthenticated(channel, fixture.username);
  });
});
