import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hostCardDirectory, listHostCards } from '../../packages/shell/src/host/host-discovery.js';

const TEMP_PREFIX = path.join(os.tmpdir(), 'dsh-host-discovery-');
const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';
const C = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const NOW = Date.parse('2026-11-10T06:58:00.000Z');

function instanceId(index) {
  return index.toString(16).padStart(2, '0').repeat(16);
}

function card(overrides = {}) {
  return {
    version: 1,
    instanceId: A,
    hostKey: 'profile:web',
    profile: 'web',
    pid: 4242,
    port: 45123,
    url: 'http://127.0.0.1:45123/?token=secret',
    startedAt: '2026-11-10T06:57:45.000Z',
    heartbeatAt: '2026-11-10T06:57:50.000Z',
    supervised: false,
    cwd: '/tmp/work',
    argv: ['/usr/local/bin/dsh', '--profile', 'web'],
    dshVersion: '0.2.2-rc.1',
    guestVersion: '0.6.0',
    ...overrides,
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(TEMP_PREFIX);
  t.after(async () => {
    assert.equal(root.startsWith(TEMP_PREFIX), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(t) {
  const root = await tempRoot(t);
  const home = path.join(root, 'home');
  const directory = hostCardDirectory(home);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const writeText = async (instance, text) => {
    const file = path.join(directory, `${instance}.json`);
    await fs.writeFile(file, text, { mode: 0o600 });
    return file;
  };
  const write = async (value, instance = value.instanceId) => {
    return writeText(instance, `${JSON.stringify(value)}\n`);
  };
  return { root, home, directory, write, writeText };
}

function list(options) {
  return listHostCards({ now: NOW, ...options });
}

test('hostCardDirectory joins the DSH home and rejects unsafe input', async (t) => {
  const root = await tempRoot(t);
  assert.equal(hostCardDirectory(path.join(root, 'home')), path.join(root, 'home', 'workspace-hosts'));
  for (const value of ['', 'relative/home', null, 42]) {
    assert.throws(() => hostCardDirectory(value), (error) => {
      assert.equal(error.code, 'HOST_CARD_INVALID_HOME');
      assert.equal(error.safe, true);
      return true;
    });
  }
});

test('a home without a card directory lists nothing', async (t) => {
  const root = await tempRoot(t);
  const listed = await list({ home: path.join(root, 'missing-home') });
  assert.deepEqual(listed, { hosts: [], skipped: [] });
  // An invalid home is empty, never a throw.
  assert.deepEqual(await list({ home: 'relative' }), { hosts: [], skipped: [] });
});

test('a valid card is listed with its identity and authenticated URL', async (t) => {
  const { home, directory, write } = await fixture(t);
  const file = await write(card());
  const listed = await list({ home, isAlive: (pid) => pid === 4242 });
  assert.deepEqual(listed.skipped, []);
  assert.equal(listed.hosts.length, 1);
  const host = listed.hosts[0];
  assert.equal(host.file, file);
  assert.equal(path.dirname(host.file), directory);
  assert.equal(host.instanceId, A);
  assert.equal(host.hostKey, 'profile:web');
  assert.equal(host.profile, 'web');
  assert.equal(host.profileId, 'web');
  assert.equal(host.pid, 4242);
  assert.equal(host.port, 45123);
  assert.equal(host.url, 'http://127.0.0.1:45123/?token=secret');
  assert.equal(host.supervised, false);
  assert.equal(host.startedAt, '2026-11-10T06:57:45.000Z');
  assert.equal(host.heartbeatAt, '2026-11-10T06:57:50.000Z');
  assert.equal(host.heartbeatStale, false);
});

test('malformed cards are skipped as HOST_CARD_INVALID', async (t) => {
  const { home, write, writeText } = await fixture(t);
  const first = instanceId(1);
  const second = instanceId(2);
  const third = instanceId(3);
  const fourth = instanceId(4);
  const fifth = instanceId(5);
  const sixth = instanceId(6);
  const seventh = instanceId(7);
  const eighth = instanceId(8);
  await writeText(first, 'not json');
  await write(card({ instanceId: second, version: 2 }), second);
  await write(card({ instanceId: third, pid: '4242' }), third);
  await write(card({ instanceId: fourth }), fifth);
  await write(card({ instanceId: sixth, hostKey: 'bad key' }), sixth);
  await write(card({ instanceId: seventh, heartbeatAt: 'yesterday' }), seventh);
  await writeText(eighth, '[]');
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped.map((item) => item.code), Array(7).fill('HOST_CARD_INVALID'));
  assert.equal(listed.skipped.length, 7);
  for (const item of listed.skipped) assert.equal(path.isAbsolute(item.file), true);
});

test('non-loopback, credentialled, and malformed URLs are rejected', async (t) => {
  const { home, write } = await fixture(t);
  const urls = [
    'https://127.0.0.1:45123/?token=secret',
    'http://127.0.0.1/?token=secret',
    'http://user:pass@127.0.0.1:45123/?token=secret',
    'http://192.168.1.5:45123/?token=secret',
    'http://localhost:not-a-port/',
    'not a url',
  ];
  for (const [index, url] of urls.entries()) {
    const instance = instanceId(index + 1);
    await write(card({ instanceId: instance, url }), instance);
  }
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped.map((item) => item.code), Array(urls.length).fill('HOST_CARD_URL_REJECTED'));
});

test('a dead pid marks the card stale even with a fresh heartbeat', async (t) => {
  const { home, write } = await fixture(t);
  await write(card({ heartbeatAt: new Date(NOW).toISOString() }));
  const listed = await list({ home, isAlive: () => false });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped, [{ file: path.join(hostCardDirectory(home), `${A}.json`), code: 'HOST_CARD_STALE' }]);
});

test('a live pid outranks a stale heartbeat', async (t) => {
  const { home, write } = await fixture(t);
  await write(card({ heartbeatAt: '2026-11-10T05:57:50.000Z' }));
  const listed = await list({ home, isAlive: () => true, staleMs: 30_000 });
  assert.equal(listed.skipped.length, 0);
  assert.equal(listed.hosts.length, 1);
  assert.equal(listed.hosts[0].heartbeatStale, true);
  // A rejected heartbeat window still trusts the pid.
  assert.equal((await list({ home, isAlive: () => true, staleMs: 0 })).hosts.length, 1);
});

test('duplicate host keys keep only the newest card', async (t) => {
  const { home, write } = await fixture(t);
  const older = await write(card({ instanceId: A, startedAt: '2026-11-10T06:00:00.000Z' }));
  await write(card({ instanceId: B, startedAt: '2026-11-10T06:57:45.000Z' }), B);
  await write(card({ instanceId: C, hostKey: 'profile:other', startedAt: '2026-11-10T06:30:00.000Z' }), C);
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.hosts.map((host) => host.instanceId).sort(), [B, C].sort());
  assert.deepEqual(listed.skipped, [{ file: older, code: 'HOST_CARD_DUPLICATE' }]);
});

test('symlinked card files and non-files are skipped', async (t) => {
  const { root, home, directory } = await fixture(t);
  const target = path.join(root, 'elsewhere.json');
  await fs.writeFile(target, `${JSON.stringify(card({ instanceId: A }))}\n`, { mode: 0o600 });
  await fs.symlink(target, path.join(directory, `${A}.json`));
  await fs.mkdir(path.join(directory, `${B}.json`));
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped.map((item) => [path.basename(item.file), item.code]), [
    [`${A}.json`, 'HOST_CARD_INVALID'],
    [`${B}.json`, 'HOST_CARD_INVALID'],
  ]);
});

test('temporary files and unrelated entries are ignored without warnings', async (t) => {
  const { home, directory, write } = await fixture(t);
  await fs.writeFile(path.join(directory, `${A}.4242.tmp`), 'partial', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'notes.txt'), 'hello', { mode: 0o600 });
  await write(card({ instanceId: B }), B);
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.skipped, []);
  assert.deepEqual(listed.hosts.map((host) => host.instanceId), [B]);
});

test('cards with invalid JSON structure never throw', async (t) => {
  const { home, writeText } = await fixture(t);
  const values = ['null', '"card"', '[]', '{}', '{"version":1}'];
  for (const [index, value] of values.entries()) {
    await writeText(instanceId(index + 1), value);
  }
  const listed = await list({ home, isAlive: () => true });
  assert.deepEqual(listed.hosts, []);
  assert.equal(listed.skipped.length, values.length);
  assert.equal(listed.skipped.every((item) => item.code === 'HOST_CARD_INVALID'), true);
});

test('a card owned by another local user is skipped', async (t) => {
  if (typeof process.getuid !== 'function') {
    t.skip('uid checks do not exist on this platform');
    return;
  }
  const { home, write } = await fixture(t);
  await write(card());
  const foreign = process.getuid() + 1;
  const listed = await listHostCards({
    home,
    now: NOW,
    isAlive: () => true,
    fs: {
      readdir: async () => [`${A}.json`],
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 256,
        uid: foreign,
      }),
      readFile: async () => `${JSON.stringify(card())}\n`,
    },
  });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped, [{ file: path.join(hostCardDirectory(home), `${A}.json`), code: 'HOST_CARD_INVALID' }]);
});

test('unreadable card entries never throw', async (t) => {
  const { home } = await fixture(t);
  const listed = await listHostCards({
    home,
    now: NOW,
    isAlive: () => true,
    fs: {
      readdir: async () => [`${A}.json`, `${B}.json`],
      lstat: async (file) => {
        if (file.endsWith(`${A}.json`)) throw new Error('denied');
        return { isFile: () => true, isSymbolicLink: () => false, size: 256 };
      },
      readFile: async () => {
        throw new Error('denied');
      },
    },
  });
  assert.deepEqual(listed.hosts, []);
  assert.deepEqual(listed.skipped.map((item) => item.code), ['HOST_CARD_INVALID', 'HOST_CARD_INVALID']);
});
