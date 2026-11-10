import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostCard, hostCardDirectory, hostKeyFor, newInstanceId } from '../../packages/guest/src/host/host-card.js';
import { inspectActiveTasks, inspectInstallLock } from '../../packages/guest/src/host/host-activity.js';

const base = {
  profile: 'web',
  port: 61599,
  url: 'http://127.0.0.1:61599/?token=t',
  cwd: '/tmp',
  argv: ['node', 'bin.js', '--profile', 'web'],
};

function home() {
  return mkdtempSync(path.join(os.tmpdir(), 'guest-host-card-'));
}

test('publishes one owner-only card and removes it on dispose', async () => {
  const root = home();
  try {
    const card = await createHostCard({ ...base, home: root, hostKey: 'runtime-7' });
    const directory = statSync(hostCardDirectory(root));
    assert.equal(directory.mode & 0o777, 0o700);
    const file = statSync(card.file);
    assert.equal(file.mode & 0o777, 0o600);
    const value = JSON.parse(readFileSync(card.file, 'utf8'));
    assert.equal(value.version, 1);
    assert.equal(value.hostKey, 'runtime-7');
    assert.equal(value.profile, 'web');
    assert.equal(value.supervised, false);
    assert.equal(value.pid, process.pid);
    assert.equal(value.instanceId.length, 32);
    assert.deepEqual(value.argv, base.argv);
    await card.dispose();
    assert.deepEqual(readdirSync(hostCardDirectory(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a heartbeat rewrites the card, and dispose still removes the newest inode', async () => {
  const root = home();
  let tick = null;
  try {
    const card = await createHostCard({
      ...base, home: root,
      timers: { setInterval: (callback) => { tick = callback; return { unref() {} }; }, clearInterval: () => {} },
    });
    const before = JSON.parse(readFileSync(card.file, 'utf8')).heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await card.refresh();
    const after = JSON.parse(readFileSync(card.file, 'utf8')).heartbeatAt;
    assert.notEqual(before, after);
    assert.ok(tick, 'heartbeat timer registered');
    await card.dispose();
    assert.deepEqual(readdirSync(hostCardDirectory(root)), [], 'the latest rename must not defeat cleanup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispose never deletes a replacement card', async () => {
  const root = home();
  try {
    const card = await createHostCard({ ...base, home: root });
    // A restarted Host publishes a new card at the same path (rename, not truncate).
    const replacement = card.file + '.replacement';
    writeFileSync(replacement, JSON.stringify({ version: 1, instanceId: 'f'.repeat(32) }));
    renameSync(replacement, card.file);
    await card.dispose();
    assert.equal(readdirSync(hostCardDirectory(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses cards that could not describe a reachable Host', async () => {
  const root = home();
  try {
    await assert.rejects(createHostCard({ ...base, home: root, url: 'https://127.0.0.1:1/' }), (error) => error.code === 'HOST_CARD_INVALID_URL');
    await assert.rejects(createHostCard({ ...base, home: root, url: 'http://example.com:1/' }), (error) => error.code === 'HOST_CARD_INVALID_URL');
    await assert.rejects(createHostCard({ ...base, home: root, port: 0 }), (error) => error.code === 'HOST_CARD_INVALID_PORT');
    await assert.rejects(createHostCard({ ...base, home: root, profile: '../etc' }), (error) => error.code === 'HOST_CARD_INVALID_PROFILE');
    await assert.rejects(createHostCard({ ...base, home: root, cwd: 'relative' }), (error) => error.code === 'HOST_CARD_INVALID_CWD');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host keys fall back to the profile and instance ids are filesystem-safe', () => {
  assert.equal(hostKeyFor('web', 'runtime-1'), 'runtime-1');
  assert.equal(hostKeyFor('web', 'not a key'), 'profile:web');
  assert.equal(hostKeyFor('web', undefined), 'profile:web');
  assert.match(newInstanceId(), /^[a-f0-9]{32}$/u);
});

test('active work is detected across agents and jobs, and unknown probes stay quiet', () => {
  const ctx = {
    get(name) {
      if (name === 'agents') return { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }, { id: 'a2', status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }, { id: 'a3', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }] };
      if (name === 'jobs') return { list: (id) => (id === undefined ? [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'done' }] : [{ id: 'j1', status: 'running' }]) };
      return undefined;
    },
  };
  const result = inspectActiveTasks(ctx);
  assert.equal(result.available, true);
  assert.equal(result.tasks, 2);
  assert.equal(result.jobs, 1, 'one job listed globally and per agent counts once');
  assert.deepEqual(inspectActiveTasks(null), { available: false, active: false, tasks: 0, jobs: 0 });
  assert.equal(inspectActiveTasks({ get: () => { throw new Error('no services'); } }).active, false);
});

test('an install lock only blocks while its pid lives, and a stale lock is removed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guest-install-lock-'));
  try {
    const runFile = path.join(root, '.plugin-manager', 'run.json');
    assert.equal(inspectInstallLock(root).locked, false);
    mkdirSync(path.dirname(runFile), { recursive: true });
    writeFileSync(runFile, JSON.stringify({ pid: 111 }));
    assert.equal(inspectInstallLock(root, { kill: () => {} }).locked, true);
    assert.equal(inspectInstallLock(root, { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }).locked, false);
    writeFileSync(runFile, JSON.stringify({ pid: 111 }));
    assert.equal(inspectInstallLock(root, { kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }).locked, true);
    writeFileSync(runFile, '{broken');
    assert.equal(inspectInstallLock(root).locked, false);
    assert.equal(inspectInstallLock('').locked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
