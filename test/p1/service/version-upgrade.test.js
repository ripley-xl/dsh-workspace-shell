import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture, waitForPhase } from './helpers.mjs';

function oldInstance(overrides = {}) {
  return {
    instance: {
      instanceId: 'old-instance',
      dshVersion: '1.0.0',
      buildId: 'build-1',
      endpoint: { host: '127.0.0.1', port: 41000 },
      ...overrides,
    },
    health: { healthy: true },
    active: true,
  };
}

test('an older saved instance is left running while the matching runtime starts a new instance', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance());
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '1.0.0', buildId: 'build-1' });
  const events = [];
  const open = fixture.service.openControllerSession;
  fixture.service.openControllerSession = async (input) => {
    const opened = await open(input);
    const stop = opened.controller.stop.bind(opened.controller);
    opened.controller.stop = async (...args) => {
      events.push('stop');
      return stop(...args);
    };
    events.push('install');
    return opened;
  };
  const upgraded = await fixture.service.connect(record.id);
  // The old runtime is another instance; it is never stopped.
  assert.deepEqual(events, ['install']);
  assert.notEqual(upgraded.host.instanceId, 'old-instance');
  assert.equal(upgraded.host.remoteVersion, '2.0.0');
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-instance');
  assert.equal(old.health.healthy, true);
});

test('an active Host upgrade reuses the shared channel and leaves other profiles online', async (t) => {
  const fixture = await serviceFixture({ version: '1.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const firstHost = fixture.service.runtime(record.id).host;
  const work = await fixture.service.webOpen(record.id, { profileId: 'work' });
  const shared = fixture.service.sessions.get(record.id).channel;
  fixture.setRuntimeVersion('2.0.0');
  const upgraded = await fixture.service.connect(record.id);
  assert.notEqual(upgraded.host.instanceId, first.host.instanceId);
  assert.equal(upgraded.host.remoteVersion, '2.0.0');
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(firstHost.closed, true);
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === first.host.instanceId);
  assert.equal(old.health.healthy, true);
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
  const workHost = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(workHost.channel, shared);
  assert.equal(workHost.closed, false);
});

test('a local DSH version change keeps the connected Host', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const firstHost = fixture.service.runtime(record.id).host;
  const channel = fixture.service.sessions.get(record.id).channel;
  fixture.setVersion('1.0.0');
  const second = await fixture.service.connect(record.id);
  // The remote runtime version comes from the bundled runtime, not local DSH.
  assert.equal(second.host.instanceId, first.host.instanceId);
  assert.equal(second.host.remoteVersion, '2.0.0');
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(firstHost.closed, false);
  assert.equal(channel.closed, false);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
});

test('a failed runtime install keeps the connected Host and shared channel', async (t) => {
  const fixture = await serviceFixture({ version: '1.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const connected = await fixture.service.connect(record.id);
  const oldInstanceId = connected.host.instanceId;
  const channel = fixture.service.sessions.get(record.id).channel;
  fixture.setRuntimeVersion('2.0.0');
  const open = fixture.service.openControllerSession;
  fixture.service.openControllerSession = async (input) => {
    if (fixture.runtimeVersion() === '2.0.0') throw Object.assign(new Error('install failed'), { code: 'REMOTE_INSTALL_FAILED' });
    return open(input);
  };
  await assert.rejects(fixture.service.connect(record.id), (error) => error.code === 'REMOTE_INSTALL_FAILED');
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(channel.closed, false);
  assert.equal(fixture.service.runtime(record.id).host?.instanceId, oldInstanceId);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
});

test('an upgrade never closes the shared channel other profile Hosts use', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const work = await fixture.service.webOpen(record.id, { profileId: 'work' });
  const shared = fixture.service.sessions.get(record.id).channel;
  fixture.state.instances.push(oldInstance());
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '1.0.0', buildId: 'build-1' });
  const connected = await fixture.service.connect(record.id);
  assert.deepEqual(fixture.state.stops, []);
  assert.notEqual(connected.host.instanceId, work.instanceId);
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-instance');
  assert.equal(old.health.healthy, true);
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
  const workHost = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(workHost.channel, shared);
  assert.equal(workHost.closed, false);
});

test('opening one profile leaves an older Host of that profile running', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ instanceId: 'old-work', profileId: 'work' }));
  const opened = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(opened.profileId, 'work');
  assert.notEqual(opened.instanceId, 'old-work');
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-work');
  assert.equal(old.health.healthy, true);
  const host = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(host.version, '2.0.0');
  assert.equal(host.closed, false);
});

test('opening one profile starts its own Host and leaves a newer Host running', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ instanceId: 'newer-work', profileId: 'work', dshVersion: '3.0.0' }));
  const opened = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(fixture.state.stops, []);
  assert.notEqual(opened.instanceId, 'newer-work');
  assert.equal(fixture.service.profileRuntime(record.id, 'work').host.version, '2.0.0');
  const instance = fixture.state.instances.find((entry) => entry.instance.instanceId === 'newer-work');
  assert.equal(instance.health.healthy, true);
});

test('reuse-only never adopts or stops an older profile Host', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ instanceId: 'old-web' }));
  await assert.rejects(fixture.service.webOpen(record.id, { profileId: 'web', reuseOnly: true }), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
  assert.deepEqual(fixture.state.stops, []);
  const instance = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-web');
  assert.equal(instance.health.healthy, true);
});

test('autoConnect upgrades an older saved instance in the background', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', autoConnect: true, syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance());
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '1.0.0', buildId: 'build-1' });
  await fixture.service.autoConnectAll();
  await waitForPhase(fixture.service, record.id, 'connected');
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(fixture.store.get(record.id).lastServerVersion, '2.0.0');
  assert.notEqual(fixture.store.get(record.id).lastInstanceId, 'old-instance');
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-instance');
  assert.equal(old.health.healthy, true);
});

test('a same-version instance from another build is left running as its own instance', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ dshVersion: '2.0.0', buildId: 'build-0' }));
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '2.0.0', buildId: 'build-0' });
  const upgraded = await fixture.service.connect(record.id);
  assert.deepEqual(fixture.state.stops, []);
  assert.notEqual(upgraded.host.instanceId, 'old-instance');
  assert.equal(upgraded.host.remoteBuildId, 'build-1');
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-instance');
  assert.equal(old.health.healthy, true);
});

test('a saved instance created by the current runtime package is reused', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.2' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push({
    instance: {
      instanceId: 'same-runtime',
      dshVersion: '2.0.0',
      buildId: 'build-1',
      createdBy: fixture.runtimeIdFor('2.0.0', '0.2.2'),
      endpoint: { host: '127.0.0.1', port: 41000 },
    },
    health: { healthy: true },
    active: true,
  });
  await fixture.store.markConnected(record.id, { instanceId: 'same-runtime', version: '2.0.0', buildId: 'build-1' });
  const connected = await fixture.service.connect(record.id);
  assert.equal(connected.host.instanceId, 'same-runtime');
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(fixture.state.instances.length, 1);
});

test('a saved instance created by an older runtime package is left running as its own instance', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.2' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push({
    instance: {
      instanceId: 'old-controller-instance',
      dshVersion: '2.0.0',
      buildId: 'build-1',
      createdBy: fixture.runtimeIdFor('2.0.0', '0.2.1'),
      endpoint: { host: '127.0.0.1', port: 41000 },
    },
    health: { healthy: true },
    active: true,
  });
  await fixture.store.markConnected(record.id, { instanceId: 'old-controller-instance', version: '2.0.0', buildId: 'build-1' });
  const connected = await fixture.service.connect(record.id);
  assert.deepEqual(fixture.state.stops, []);
  assert.notEqual(connected.host.instanceId, 'old-controller-instance');
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === connected.host.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === 'old-controller-instance');
  assert.equal(old.health.healthy, true);
  assert.equal(connected.host.lastServerVersion, '2.0.0');
});

test('an active Host on an older runtime package is detached on the shared channel', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.1' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const firstHost = fixture.service.runtime(record.id).host;
  const shared = fixture.service.sessions.get(record.id).channel;
  fixture.setControllerVersion('0.2.2');
  const second = await fixture.service.connect(record.id);
  assert.notEqual(second.host.instanceId, first.host.instanceId);
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(firstHost.closed, true);
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === first.host.instanceId);
  assert.equal(old.health.healthy, true);
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === second.host.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
});

test('a profile Host on an older runtime package is left running when reopened', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.1' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.webOpen(record.id, { profileId: 'work' });
  fixture.setControllerVersion('0.2.2');
  await fixture.service.disconnect(record.id);
  const second = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(fixture.state.stops, []);
  assert.notEqual(second.instanceId, first.instanceId);
  const old = fixture.state.instances.find((entry) => entry.instance.instanceId === first.instanceId);
  assert.equal(old.health.healthy, true);
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === second.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
});
