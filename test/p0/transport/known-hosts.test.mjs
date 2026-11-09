import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  knownHostName,
  matchKnownHostKey,
  sshKeyType,
  verifyHostKey,
} from '../../../packages/manager/src/host/ssh/known-hosts.js';
import { knownHostsLine, wireKey } from './helpers.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-known-hosts-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'known_hosts');
  const key = wireKey();
  return { directory, file, key };
}

function verificationOptions(file, overrides = {}) {
  return {
    globalKnownHostsFiles: [],
    hostname: 'unit.test.invalid',
    keyType: 'ssh-ed25519',
    port: 22,
    strictHostKeyChecking: 'yes',
    userKnownHostsFiles: [file],
    ...overrides,
  };
}

test('known_hosts accepts a matching key and derives its key type', async (t) => {
  const { file, key } = await fixture(t);
  await fs.writeFile(file, knownHostsLine('unit.test.invalid', key), { mode: 0o600 });
  const result = await verifyHostKey(key, verificationOptions(file));
  assert.equal(result.status, 'matched');
  assert.match(result.fingerprint, /^SHA256:/u);
  assert.equal(sshKeyType(key), 'ssh-ed25519');
  const globalResult = await verifyHostKey(key, verificationOptions(file, {
    globalKnownHostsFiles: [file],
    userKnownHostsFiles: [],
  }));
  assert.equal(globalResult.status, 'matched');
});

test('known_hosts supports hashed hosts, wildcards and negated patterns', async (t) => {
  const { file, key } = await fixture(t);
  const host = 'unit.test.invalid';
  const salt = Buffer.from('12345678901234567890');
  const hash = createHmac('sha1', salt).update(host).digest('base64');
  const hashed = `|1|${salt.toString('base64')}|${hash}`;
  await fs.writeFile(file, [
    knownHostsLine('*.invalid,!blocked.invalid', key),
    knownHostsLine(hashed, wireKey('ssh-ed25519', Buffer.alloc(32, 9))),
  ].join(''));
  assert.equal((await matchKnownHostKey({
    hostname: host,
    key,
    port: 22,
    userKnownHostsFiles: [file],
  })).status, 'matched');
  assert.equal((await matchKnownHostKey({
    hostname: 'blocked.invalid',
    key,
    port: 22,
    userKnownHostsFiles: [file],
  })).status, 'unknown');
});

test('HostKeyAlias and non-default ports select the OpenSSH lookup name', async (t) => {
  const { file, key } = await fixture(t);
  assert.equal(knownHostName('real.invalid', 2222, 'trusted-name'), '[trusted-name]:2222');
  await fs.writeFile(file, knownHostsLine('[trusted-name]:2222', key));
  const result = await matchKnownHostKey({
    hostname: 'real.invalid',
    hostKeyAlias: 'trusted-name',
    key,
    port: 2222,
    userKnownHostsFiles: [file],
  });
  assert.equal(result.status, 'matched');
});

test('unknown and changed host keys fail closed without interaction', async (t) => {
  const { file, key } = await fixture(t);
  await assert.rejects(verifyHostKey(key, verificationOptions(file)), {
    code: 'SSH_HOST_KEY_UNKNOWN',
  });

  await fs.writeFile(file, knownHostsLine('unit.test.invalid', wireKey('ssh-ed25519', Buffer.alloc(32, 8))));
  await assert.rejects(verifyHostKey(key, verificationOptions(file)), {
    code: 'SSH_HOST_KEY_CHANGED',
  });
});

test('a known_hosts record with a mismatched key algorithm is not trusted', async (t) => {
  const { file, key } = await fixture(t);
  await fs.writeFile(file, knownHostsLine('unit.test.invalid', key, 'ssh-rsa'));
  await assert.rejects(verifyHostKey(key, verificationOptions(file)), {
    code: 'SSH_HOST_KEY_CHANGED',
  });
});

test('a revoked key fails even when another record trusts it', async (t) => {
  const { file, key } = await fixture(t);
  await fs.writeFile(file, [
    knownHostsLine('unit.test.invalid', key),
    knownHostsLine('unit.test.invalid', key, 'ssh-ed25519', '@revoked'),
  ].join(''));
  await assert.rejects(verifyHostKey(key, verificationOptions(file)), {
    code: 'SSH_HOST_KEY_REVOKED',
  });
});

test('accept-new records only an unknown key during an interactive connection', async (t) => {
  const { file, key } = await fixture(t);
  const acceptNew = verificationOptions(file, { strictHostKeyChecking: 'accept-new' });
  await assert.rejects(verifyHostKey(key, acceptNew), { code: 'SSH_HOST_KEY_UNKNOWN' });
  assert.equal(await fs.readFile(file, 'utf8').catch((error) => error.code), 'ENOENT');

  const accepted = await verifyHostKey(key, { ...acceptNew, interactive: true });
  assert.equal(accepted.status, 'accepted-new');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(file, 'utf8'), knownHostsLine('unit.test.invalid', key));

  await fs.writeFile(file, knownHostsLine('unit.test.invalid', wireKey('ssh-ed25519', Buffer.alloc(32, 8))));
  await assert.rejects(verifyHostKey(key, { ...acceptNew, interactive: true }), {
    code: 'SSH_HOST_KEY_CHANGED',
  });
});
