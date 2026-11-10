import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from './helpers.mjs';

const INSTANCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function card(overrides = {}) {
  return {
    version: 1,
    instanceId: INSTANCE,
    hostKey: 'profile:web',
    profile: 'web',
    pid: 4321,
    port: 3080,
    url: 'http://127.0.0.1:3080/?token=secret-token',
    startedAt: new Date('2026-11-10T00:00:00.000Z').toISOString(),
    heartbeatAt: new Date('2026-11-10T00:00:00.000Z').toISOString(),
    supervised: false,
    cwd: '/home/test',
    argv: ['node', 'dsh'],
    guestVersion: '0.6.1',
    ...overrides,
  };
}

/** Connects a fixture host and makes its SSH channel answer with card output. */
async function connectedFixture(t, output, { alive = true } = {}) {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const session = fixture.service.session(record.id);
  session.channel.exec = async (request) => {
    fixture.state.execs.push(request);
    // The discovery reads cards, then asks which pids are alive.
    if (request.command === 'sh' && String(request.args?.[1] ?? '').includes('kill -0')) {
      if (!alive) return { code: 0, stdout: '', stderr: '' };
      const pids = [...String(request.args[1]).matchAll(/\b(\d{2,7})\b/gu)].map((match) => match[1]);
      return { code: 0, stdout: pids.join('\n') + '\n', stderr: '' };
    }
    return { code: 0, stdout: typeof output === 'function' ? output(request) : output, stderr: '' };
  };
  return { fixture, record };
}

test('discovered hosts are read over the connected channel without their token', async (t) => {
  const { fixture, record } = await connectedFixture(t, JSON.stringify(card()) + '\n');
  const listed = await fixture.service.discoveredHosts(record.id);
  assert.equal(listed.ok, true);
  assert.equal(listed.hosts.length, 1);
  assert.equal(listed.hosts[0].instanceId, INSTANCE);
  assert.equal(listed.hosts[0].profileId, 'web');
  assert.equal(JSON.stringify(listed).includes('secret-token'), false, 'the authenticated URL never leaves the host');
  const reads = fixture.state.execs.filter((request) => String(request.args?.[1] ?? '').includes('workspace-hosts'));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].command, 'sh');
  // The second round trip only asks which pids are alive.
  assert.equal(fixture.state.execs.some((request) => String(request.args?.[1] ?? '').includes('kill -0')), true);
});

test('attaching a discovered Host reuses an active forward and rewrites the URL', async (t) => {
  const { fixture, record } = await connectedFixture(t, JSON.stringify(card()));
  const runtime = fixture.service.runtime(record.id);
  const forward = { id: 'forward-1', state: 'active', localHost: '127.0.0.1', localPort: 40_001, remoteHost: '127.0.0.1', remotePort: 3080 };
  runtime.portManager = { closed: false, list: () => [forward], add: async () => forward, on() {}, off() {} };
  const attached = await fixture.service.attachDiscovered(record.id, { instanceId: INSTANCE });
  assert.equal(attached.instanceId, INSTANCE);
  assert.equal(attached.profileId, 'web');
  assert.equal(attached.url, 'http://127.0.0.1:40001/?token=secret-token');
});

test('attach refuses an unknown card and one this manager already owns', async (t) => {
  const { fixture, record } = await connectedFixture(t, JSON.stringify(card()));
  await assert.rejects(
    fixture.service.attachDiscovered(record.id, { instanceId: 'f'.repeat(32) }),
    (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE',
  );
  // Controller instance ids are UUIDs, never the 32-hex shape of a Host card.
  await assert.rejects(
    fixture.service.attachDiscovered(record.id, { instanceId: 'instance-1' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('discovery requires a connected host', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test' });
  await assert.rejects(fixture.service.discoveredHosts(record.id), (error) => error.code === 'HOST_NOT_CONNECTED');
});

test('a supervised card is not offered as another Host', async (t) => {
  const { fixture, record } = await connectedFixture(t, JSON.stringify(card({ supervised: true })));
  const listed = await fixture.service.discoveredHosts(record.id);
  assert.deepEqual(listed.hosts, []);
  assert.ok(listed.skipped.some((item) => item.code === 'HOST_CARD_SUPERVISED'));
});

test('a card whose process is gone is not listed and cannot be attached', async (t) => {
  const { fixture, record } = await connectedFixture(t, JSON.stringify(card()), { alive: false });
  const listed = await fixture.service.discoveredHosts(record.id);
  assert.deepEqual(listed.hosts, []);
  await assert.rejects(
    fixture.service.attachDiscovered(record.id, { instanceId: INSTANCE }),
    (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE',
  );
});

/** A channel that models one Host being killed and (optionally) respawned. */
async function lifecycleFixture(t, { respawn = false } = {}) {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const session = fixture.service.session(record.id);
  const state = { alive: true, spawned: false, card: card() };
  session.channel.exec = async (request) => {
    fixture.state.execs.push(request);
    const script = String(request.args?.[1] ?? '');
    if (request.command === 'sh' && script.includes('kill -0')) {
      return { code: 0, stdout: state.alive ? `${state.card.pid}\n` : '', stderr: '' };
    }
    if (request.command === 'kill') {
      state.alive = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('nohup')) {
      state.spawned = true;
      if (respawn) { state.alive = true; state.card = card({ instanceId: 'b'.repeat(32), pid: 9876, port: 3081 }); }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('workspace-hosts')) {
      const payload = state.alive ? JSON.stringify(state.card) : '';
      return { code: 0, stdout: payload ? `${payload}\n` : '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { fixture, record, state };
}

test('stop signals the process and confirms it is gone', async (t) => {
  const { fixture, record, state } = await lifecycleFixture(t);
  const result = await fixture.service.stopDiscovered(record.id, { instanceId: INSTANCE });
  assert.equal(result.stopped, true);
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(state.alive, false);
  const kills = fixture.state.execs.filter((request) => request.command === 'kill');
  assert.deepEqual(kills.map((request) => request.args[0]), ['-TERM']);
});

test('restart replays the card command line and waits for the new card', async (t) => {
  const { fixture, record, state } = await lifecycleFixture(t, { respawn: true });
  const result = await fixture.service.restartDiscovered(record.id, { instanceId: INSTANCE });
  assert.equal(result.ok, true);
  assert.equal(result.previousInstanceId, INSTANCE);
  assert.equal(result.instanceId, 'b'.repeat(32));
  assert.equal(state.spawned, true);
  const respawn = fixture.state.execs.find((request) => String(request.args?.[1] ?? '').includes('nohup'));
  assert.match(respawn.args[1], /cd '\/home\/test'/u);
  assert.match(respawn.args[1], /'dsh'/u);
});

test('stop and restart refuse supervised or dead cards', async (t) => {
  const { fixture, record, state } = await lifecycleFixture(t);
  state.alive = false;
  await assert.rejects(
    fixture.service.stopDiscovered(record.id, { instanceId: INSTANCE }),
    (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE',
  );
  state.alive = true;
  state.card = card({ supervised: true });
  await assert.rejects(
    fixture.service.restartDiscovered(record.id, { instanceId: INSTANCE }),
    (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE',
  );
});

test('sync installs missing plugins, aligns configuration and restarts the Host', async (t) => {
  const localHome = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sync-home-'));
  const fsMod = await import('node:fs');
  fsMod.mkdirSync((await import('node:path')).join(localHome, 'profiles', 'web'), { recursive: true });
  fsMod.writeFileSync((await import('node:path')).join(localHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: local-only-entry\n  name: demo\n');
  t.after(() => fsMod.rmSync(localHome, { recursive: true, force: true }));
  const fixture = await serviceFixture({
    localBundles: async () => [{ name: 'dsh-missing', version: '1.0.0' }],
  });
  t.after(fixture.close);
  fixture.service.localHome = () => localHome;
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const session = fixture.service.session(record.id);
  const state = { alive: true, card: card(), installs: [], uploaded: 0 };
  session.channel.upload = async () => { state.uploaded += 1; };
  session.channel.exec = async (request) => {
    fixture.state.execs.push(request);
    const script = String(request.args?.[1] ?? '');
    if (request.command === 'sh' && script.includes('kill -0')) return { code: 0, stdout: state.alive ? `${state.card.pid}\n` : '', stderr: '' };
    if (request.command === 'kill') { state.alive = false; return { code: 0, stdout: '', stderr: '' }; }
    if (request.command === 'sh' && script.includes('profiles/web/package.json')) return { code: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: '' };
    if (request.command === 'sh' && script.includes('nohup')) {
      state.alive = true;
      state.card = card({ instanceId: 'b'.repeat(32), pid: 9876, port: 3081 });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('workspace-hosts')) {
      return { code: 0, stdout: state.alive ? `${JSON.stringify(state.card)}\n` : '', stderr: '' };
    }
    if (request.command === 'node' && request.args?.includes('plugin')) {
      state.installs.push(request.args);
      return { code: 0, stdout: 'installed\n', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('cordis.patch.yml')) return { code: 0, stdout: '- id: remote-entry\n', stderr: '' };
    if (request.command === 'node' && request.args?.includes('--dump-config')) return { code: 0, stdout: '[]\n', stderr: '' };
    if (request.command === 'mv') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await fixture.service.syncDiscovered(record.id, { instanceId: INSTANCE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => [item.name, item.ok]), [['dsh-missing', true]]);
  assert.deepEqual(state.installs[0], ['dsh', 'plugin', '--profile', 'web', 'add', 'dsh-missing@1.0.0']);
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.appended, ['local-only-entry']);
  assert.equal(state.uploaded, 1);
  assert.equal(result.restarted.instanceId, 'b'.repeat(32));
});

test('web/open adopts or starts a guest Host instead of a controller instance', async (t) => {
  const fixture = await serviceFixture(); // local version 1.0.0
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const instancesAfterConnect = fixture.state.instances.length;
  const session = fixture.service.session(record.id);
  const runtime = fixture.service.runtime(record.id);
  const cards = [];
  let started = 0;
  let alive = true;
  session.channel.exec = async (request) => {
    fixture.state.execs.push(request);
    const script = String(request.args?.[1] ?? '');
    if (request.command === 'sh' && script.includes('command -v node')) {
      return { code: 0, stdout: '/opt/node\n/opt/dsh\n', stderr: '' };
    }
    if (request.command === '/opt/node' && request.args?.[0] === '/opt/dsh' && request.args?.includes('--version')) {
      return { code: 0, stdout: '1.0.0\n', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('nohup')) {
      started += 1;
      const now = new Date().toISOString();
      cards.push(card({ hostKey: 'profile:web', profile: 'web', pid: 5555, port: 3090, url: 'http://127.0.0.1:3090/?token=guest-token', cwd: '/home/user', argv: ['/opt/node', '/opt/dsh'], startedAt: now, heartbeatAt: now }));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (request.command === 'sh' && script.includes('workspace-hosts')) {
      return { code: 0, stdout: cards.map((item) => JSON.stringify(item)).join('\n') + (cards.length ? '\n' : ''), stderr: '' };
    }
    if (request.command === 'sh' && script.includes('kill -0')) return { code: 0, stdout: alive ? '5555\n' : '', stderr: '' };
    if (request.command === 'kill') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
    if (request.command === 'sh' && script.includes('cordis.patch.yml')) return { code: 0, stdout: '', stderr: '' };
    if (request.command === 'mv') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const forward = { id: 'guest-forward', state: 'active', localHost: '127.0.0.1', localPort: 40_010, remoteHost: '127.0.0.1', remotePort: 3090 };
  runtime.portManager = { closed: false, list: () => [forward], add: async () => forward, on() {}, off() {} };

  const opened = await fixture.service.webOpen(record.id, { profileId: 'web' });
  assert.equal(opened.guest, true);
  assert.equal(opened.instanceId.length, 32);
  assert.equal(opened.url, 'http://127.0.0.1:40010/?token=guest-token');
  assert.equal(started, 1, 'the remote dsh was started once');
  assert.equal(fixture.state.instances.length, instancesAfterConnect, 'no controller instance was created');

  const attached = await fixture.service.webAttach(record.id, { instanceId: opened.instanceId });
  assert.equal(attached.url, opened.url);

  const stopped = await fixture.service.webStop(record.id, { instanceId: opened.instanceId });
  assert.equal(stopped.stopped, true);
  assert.equal(alive, false);
});

test('cleanup removes the old runtime directories and reports the freed size', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const session = fixture.service.session(record.id);
  session.channel.exec = async (request) => {
    fixture.state.execs.push(request);
    const script = String(request.args?.[1] ?? '');
    if (script.includes('du -sk')) return { code: 0, stdout: '2048\n', stderr: '' };
    if (script.includes('rm -rf servers')) return { code: 0, stdout: '/home/test/.dsh/ssh-remote\n', stderr: '' };
    if (script.includes('workspace-hosts')) return { code: 0, stdout: '', stderr: '' };
    if (script.includes('kill -0')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await fixture.service.cleanupRemoteRuntime(record.id);
  assert.equal(result.ok, true);
  assert.equal(result.freedBytes, 2048 * 1024);
  const cleanup = fixture.state.execs.find((request) => String(request.args?.[1] ?? '').includes('rm -rf servers'));
  assert.match(cleanup.args[1], /instances locks logs tmp/u);
});

test('cleanup is refused while a controller-managed Host is running', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const session = fixture.service.session(record.id);
  session.channel.exec = async (request) => {
    const script = String(request.args?.[1] ?? '');
    if (script.includes('workspace-hosts')) {
      return { code: 0, stdout: JSON.stringify({ ...card(), supervised: true, pid: 4242 }) + '\n', stderr: '' };
    }
    if (script.includes('kill -0')) return { code: 0, stdout: '4242\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(
    fixture.service.cleanupRemoteRuntime(record.id),
    (error) => error.code === 'REMOTE_RUNTIME_IN_USE',
  );
});
