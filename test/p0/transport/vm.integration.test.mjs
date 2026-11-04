import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { connectResolvedSsh } from '../../../packages/shell/ssh-remote/src/host/ssh/connection.js';
import { appendKnownHostKey } from '../../../packages/shell/ssh-remote/src/host/ssh/known-hosts.js';
import { knownHostsLine, wireKey } from './helpers.mjs';

const execute = promisify(execFile);
const VM_NAME = 'dsh-ssh-remote-p0';
const enabled = process.env.DSH_SSH_REMOTE_P0_VM === '1';

function scalar(output, key) {
  const match = output.match(new RegExp(`^${key} (.+)$`, 'mu'));
  if (!match) throw new Error(`Missing ${key} in the Lima SSH configuration.`);
  return match[1];
}

async function vmConfig(knownHostsFile) {
  const configFile = path.join(os.homedir(), '.lima', VM_NAME, 'ssh.config');
  const { stdout } = await execute('ssh', [
    '-G',
    '-F',
    configFile,
    `lima-${VM_NAME}`,
  ], { encoding: 'utf8', timeout: 10_000 });
  const identityFile = scalar(stdout, 'identityfile');
  return {
    alias: `lima-${VM_NAME}`,
    globalKnownHostsFiles: [],
    hostname: scalar(stdout, 'hostname'),
    identityAgent: null,
    identityFiles: [identityFile],
    port: Number(scalar(stdout, 'port')),
    strictHostKeyChecking: 'yes',
    user: scalar(stdout, 'user'),
    userKnownHostsFiles: [knownHostsFile],
  };
}

async function readBanner(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let bytes = Buffer.alloc(0);
  try {
    await once(socket, 'connect');
    while (!bytes.includes(Buffer.from('\n'))) {
      const [chunk] = await once(socket, 'data');
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4096) throw new Error('SSH banner exceeded the test limit.');
    }
    return bytes.toString('utf8').split('\n')[0];
  } finally {
    socket.destroy();
  }
}

test('isolated Lima VM: strict SSH, exec JSON, SFTP and direct-tcpip', { skip: !enabled, timeout: 60_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-vm-transport-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const knownHosts = path.join(directory, 'known_hosts');
  const config = await vmConfig(knownHosts);

  const { stdout: hostPublicKey } = await execute('limactl', [
    'shell',
    VM_NAME,
    '--',
    'cat',
    '/etc/ssh/ssh_host_ed25519_key.pub',
  ], { encoding: 'utf8', timeout: 15_000 });
  const [keyType, encodedKey] = hostPublicKey.trim().split(/\s+/u);
  assert.equal(keyType, 'ssh-ed25519');
  const hostKey = Buffer.from(encodedKey, 'base64');
  await appendKnownHostKey(knownHosts, {
    hostname: config.hostname,
    key: hostKey,
    keyType,
    port: config.port,
  });

  const channel = await connectResolvedSsh(config, { readyTimeoutMs: 15_000 });
  const remotePath = `/tmp/dsh-ssh-p0-${process.pid}-${Date.now()}`;
  t.after(async () => {
    if (!channel.closed) {
      await channel.exec({ args: ['--', remotePath], command: '/bin/rm', timeoutMs: 5000 }).catch(() => {});
    }
    await channel.close();
  });

  const response = await channel.execJson({
    args: ['-c', `read line; printf '{"protocolVersion":1,"requestId":"vm-exec"}\\n'`],
    command: '/bin/sh',
    payload: { probe: true },
    protocolVersion: 1,
    requestId: 'vm-exec',
  });
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.requestId, 'vm-exec');

  const payload = Buffer.from('SFTP upload through the isolated VM\n');
  const localPath = path.join(directory, 'payload.txt');
  await fs.writeFile(localPath, payload);
  const uploaded = await channel.upload(localPath, remotePath);
  assert.equal(uploaded.bytes, payload.length);
  const downloaded = await channel.exec({ args: ['--', remotePath], command: '/bin/cat' });
  assert.equal(downloaded.code, 0);
  assert.equal(downloaded.stdout, payload.toString('utf8'));

  const gateway = channel.createLoopbackGateway({ remotePort: 22 });
  const address = await gateway.listen();
  assert.equal(address.host, '127.0.0.1');
  assert.match(await readBanner(address.port), /^SSH-2\.0-/u);
  await gateway.close();

  const changedFile = path.join(directory, 'changed_known_hosts');
  await fs.writeFile(changedFile, knownHostsLine(
    `[${config.hostname}]:${config.port}`,
    wireKey('ssh-ed25519', Buffer.alloc(32, 99)),
  ), { mode: 0o600 });
  await assert.rejects(connectResolvedSsh({
    ...config,
    userKnownHostsFiles: [changedFile],
  }), { code: 'SSH_HOST_KEY_CHANGED' });

  const unknownFile = path.join(directory, 'unknown_known_hosts');
  await assert.rejects(connectResolvedSsh({
    ...config,
    userKnownHostsFiles: [unknownFile],
  }), { code: 'SSH_HOST_KEY_UNKNOWN' });
});
