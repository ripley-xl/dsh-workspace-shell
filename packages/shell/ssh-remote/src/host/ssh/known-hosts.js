import {
  constants as fsConstants,
  promises as fs,
} from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { SshRemoteError } from './errors.js';

function keyFingerprint(key) {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

export function sshKeyType(key) {
  if (!Buffer.isBuffer(key) || key.length < 4) return undefined;
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 64 || key.length < 4 + length) return undefined;
  const type = key.subarray(4, 4 + length).toString('ascii');
  return /^[A-Za-z0-9@._+-]+$/u.test(type) ? type : undefined;
}

export function knownHostName(hostname, port, hostKeyAlias) {
  const host = (hostKeyAlias || hostname).toLowerCase();
  return port === 22 ? host : `[${host}]:${port}`;
}

function decodeBase64(value) {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 === 1) return null;
  const decoded = Buffer.from(value, 'base64');
  const normalizedInput = value.replace(/=+$/u, '');
  const normalizedOutput = decoded.toString('base64').replace(/=+$/u, '');
  return normalizedInput === normalizedOutput ? decoded : null;
}

function parseKnownHostsLine(line) {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 3) return null;
  let marker;
  if (fields[0].startsWith('@')) marker = fields.shift().toLowerCase();
  if (fields.length < 3) return null;
  const [hostField, keyType, encodedKey] = fields;
  const key = decodeBase64(encodedKey);
  if (!key || !/^[A-Za-z0-9@._+-]+$/u.test(keyType)) return null;
  return {
    hosts: hostField.split(','),
    key,
    keyType,
    marker,
  };
}

function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function matchHashedHost(pattern, host) {
  const fields = pattern.split('|');
  if (fields.length !== 4 || fields[0] !== '' || fields[1] !== '1') return false;
  const salt = decodeBase64(fields[2]);
  const expected = decodeBase64(fields[3]);
  if (!salt || !expected) return false;
  const actual = createHmac('sha1', salt).update(host).digest();
  return equalBytes(actual, expected);
}

function matchWildcard(pattern, host) {
  const expression = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 'u').test(host);
}

function matchHostField(patterns, host) {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const positive = negated ? pattern.slice(1) : pattern;
    const matches = positive.startsWith('|1|')
      ? matchHashedHost(positive, host)
      : matchWildcard(positive, host);
    if (matches && negated) return false;
    if (matches) matched = true;
  }
  return matched;
}

async function readKnownHosts(files) {
  const entries = [];
  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new SshRemoteError('SSH_CONFIG_INVALID', 'A known_hosts file could not be read.', {
        cause: error,
      });
    }
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const entry = parseKnownHostsLine(trimmed);
      if (entry) entries.push({ ...entry, file });
    }
  }
  return entries;
}

export async function matchKnownHostKey(options) {
  const {
    globalKnownHostsFiles = [],
    hostKeyAlias,
    hostname,
    key,
    port,
    userKnownHostsFiles = [],
  } = options;
  if (!Buffer.isBuffer(key) || key.length === 0) {
    throw new SshRemoteError('SSH_HOST_KEY_CHANGED', 'The SSH server returned an invalid host key.');
  }
  const host = knownHostName(hostname, port, hostKeyAlias);
  const entries = await readKnownHosts([...userKnownHostsFiles, ...globalKnownHostsFiles]);
  const matchingHost = entries.filter((entry) => (
    entry.marker !== '@cert-authority' && matchHostField(entry.hosts, host)
  ));
  const fingerprint = keyFingerprint(key);
  const presentedKeyType = sshKeyType(key);

  if (matchingHost.some((entry) => entry.marker === '@revoked' && equalBytes(entry.key, key))) {
    return { fingerprint, host, status: 'revoked' };
  }
  if (matchingHost.some((entry) => (
    entry.marker !== '@revoked'
    && entry.keyType === presentedKeyType
    && equalBytes(entry.key, key)
  ))) {
    return { fingerprint, host, status: 'matched' };
  }
  if (matchingHost.length > 0) return { fingerprint, host, status: 'changed' };
  return { fingerprint, host, status: 'unknown' };
}

export async function appendKnownHostKey(file, options) {
  const { hostname, hostKeyAlias, key, keyType, port } = options;
  if (!file || !Buffer.isBuffer(key) || !keyType || !/^[A-Za-z0-9@._+-]+$/u.test(keyType)) {
    throw new SshRemoteError('SSH_CONFIG_INVALID', 'The new host key could not be recorded.');
  }
  await fs.mkdir(path.dirname(file), { mode: 0o700, recursive: true });

  let needsNewline = false;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        needsNewline = last[0] !== 10;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const host = knownHostName(hostname, port, hostKeyAlias);
  const line = `${needsNewline ? '\n' : ''}${host} ${keyType} ${key.toString('base64')}\n`;
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(line, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function verifyHostKey(key, options) {
  const result = await matchKnownHostKey({ ...options, key });
  if (result.status === 'matched') return result;
  if (result.status === 'revoked') {
    throw new SshRemoteError('SSH_HOST_KEY_REVOKED', 'The SSH host key has been revoked.', {
      details: { fingerprint: result.fingerprint, host: result.host },
    });
  }
  if (result.status === 'changed') {
    throw new SshRemoteError('SSH_HOST_KEY_CHANGED', 'The SSH host key does not match known_hosts.', {
      details: { fingerprint: result.fingerprint, host: result.host },
    });
  }
  if (options.strictHostKeyChecking === 'accept-new' && options.interactive === true) {
    const file = options.userKnownHostsFiles?.[0];
    if (file) {
      await appendKnownHostKey(file, {
        hostname: options.hostname,
        hostKeyAlias: options.hostKeyAlias,
        key,
        keyType: options.keyType,
        port: options.port,
      });
      return { ...result, status: 'accepted-new' };
    }
  }
  throw new SshRemoteError('SSH_HOST_KEY_UNKNOWN', 'The SSH host key is not trusted.', {
    details: { fingerprint: result.fingerprint, host: result.host },
  });
}
