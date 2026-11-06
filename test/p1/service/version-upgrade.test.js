import assert from 'node:assert/strict';
import test from 'node:test';

import { compareDshVersions } from '../../../packages/manager/src/host/dsh-version.js';
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

test('compareDshVersions orders releases, pre-releases and build metadata', () => {
  assert.equal(compareDshVersions('0.2.2-rc.1', '0.2.1-rc.5'), 1);
  assert.equal(compareDshVersions('0.2.1-rc.5', '0.2.2-rc.1'), -1);
  assert.equal(compareDshVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareDshVersions(' 1.0.0 ', '1.0.0'), 0);
  // A pre-release sorts before its release.
  assert.equal(compareDshVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareDshVersions('1.0.0', '1.0.0-rc.9'), 1);
  // Numeric identifiers compare numerically, not as strings.
  assert.equal(compareDshVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareDshVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareDshVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareDshVersions('1.0.0-beta', '1.0.0-rc'), -1);
  // A shorter identifier list sorts first when the shared prefix matches.
  assert.equal(compareDshVersions('1.0.0-rc', '1.0.0-rc.1'), -1);
  // Build metadata never affects ordering.
  assert.equal(compareDshVersions('1.0.0+build.7', '1.0.0'), 0);
  assert.equal(compareDshVersions('0.2.2-rc.1+sha', '0.2.2-rc.1'), 0);
  // Core numbers dominate pre-release ordering.
  assert.equal(compareDshVersions('2.0.0-alpha', '1.9.9'), 1);
});

test('compareDshVersions returns null for values that are not complete versions', () => {
  assert.equal(compareDshVersions('1.0', '1.0.0'), null);
  assert.equal(compareDshVersions('1.0.0', '1.0'), null);
  assert.equal(compareDshVersions('1.0.0.1', '1.0.0'), null);
  assert.equal(compareDshVersions('v1.0.0', '1.0.0'), null);
  assert.equal(compareDshVersions('', '1.0.0'), null);
  assert.equal(compareDshVersions(undefined, '1.0.0'), null);
  assert.equal(compareDshVersions('1.0.0', null), null);
});

test('an older saved instance is replaced after its matching runtime is installed', async (t) => {
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
  // The new runtime is installed before the old remote instance is stopped.
  assert.deepEqual(events, ['install', 'stop']);
  assert.notEqual(upgraded.host.instanceId, 'old-instance');
  assert.equal(upgraded.host.remoteVersion, '2.0.0');
});

test('an active Host upgrade reuses the shared channel and leaves other profiles online', async (t) => {
  const fixture = await serviceFixture({ version: '1.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const work = await fixture.service.webOpen(record.id, { profileId: 'work' });
  const shared = fixture.service.sessions.get(record.id).channel;
  fixture.setVersion('2.0.0');
  const upgraded = await fixture.service.connect(record.id);
  assert.notEqual(upgraded.host.instanceId, first.host.instanceId);
  assert.equal(upgraded.host.remoteVersion, '2.0.0');
  assert.equal(fixture.state.stops.includes(first.host.instanceId), true);
  assert.equal(fixture.state.stops.includes(work.instanceId), false);
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
  const workHost = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(workHost.channel, shared);
  assert.equal(workHost.closed, false);
});

test('an active Host newer than the local DSH is refused and left connected', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const channel = fixture.service.sessions.get(record.id).channel;
  fixture.setVersion('1.0.0');
  await assert.rejects(fixture.service.connect(record.id), (error) => {
    assert.equal(error.code, 'LOCAL_DSH_OUTDATED');
    assert.equal(error.details.localVersion, '1.0.0');
    assert.equal(error.details.remoteVersion, '2.0.0');
    assert.equal(error.details.instanceId, first.host.instanceId);
    return true;
  });
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(channel.closed, false);
  assert.equal(fixture.service.runtime(record.id).host?.instanceId, first.host.instanceId);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
});

test('a failed runtime install keeps the connected Host and shared channel', async (t) => {
  const fixture = await serviceFixture({ version: '1.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const connected = await fixture.service.connect(record.id);
  const oldInstanceId = connected.host.instanceId;
  const channel = fixture.service.sessions.get(record.id).channel;
  fixture.setVersion('2.0.0');
  const open = fixture.service.openControllerSession;
  fixture.service.openControllerSession = async (input) => {
    if (input.version === '2.0.0') throw Object.assign(new Error('install failed'), { code: 'REMOTE_INSTALL_FAILED' });
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
  assert.deepEqual(fixture.state.stops, ['old-instance']);
  assert.notEqual(connected.host.instanceId, work.instanceId);
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
  const workHost = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(workHost.channel, shared);
  assert.equal(workHost.closed, false);
});

test('opening one profile retires an older Host of that profile only', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ instanceId: 'old-work', profileId: 'work' }));
  const opened = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(fixture.state.stops, ['old-work']);
  assert.equal(opened.profileId, 'work');
  assert.notEqual(opened.instanceId, 'old-work');
  const host = fixture.service.profileRuntime(record.id, 'work').host;
  assert.equal(host.version, '2.0.0');
  assert.equal(host.closed, false);
});

test('opening one profile refuses a newer remote Host without stopping it', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ instanceId: 'newer-work', profileId: 'work', dshVersion: '3.0.0' }));
  await assert.rejects(fixture.service.webOpen(record.id, { profileId: 'work' }), (error) => {
    assert.equal(error.code, 'LOCAL_DSH_OUTDATED');
    assert.equal(error.details.localVersion, '2.0.0');
    assert.equal(error.details.remoteVersion, '3.0.0');
    assert.equal(error.details.profileId, 'work');
    return true;
  });
  assert.deepEqual(fixture.state.stops, []);
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
  assert.deepEqual(fixture.state.stops, ['old-instance']);
  assert.equal(fixture.store.get(record.id).lastServerVersion, '2.0.0');
  assert.notEqual(fixture.store.get(record.id).lastInstanceId, 'old-instance');
});

test('a same-version instance from another build is upgraded automatically', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push(oldInstance({ dshVersion: '2.0.0', buildId: 'build-0' }));
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '2.0.0', buildId: 'build-0' });
  const upgraded = await fixture.service.connect(record.id);
  assert.deepEqual(fixture.state.stops, ['old-instance']);
  assert.equal(upgraded.host.remoteBuildId, 'build-1');
  assert.equal(upgraded.host.lastServerVersion, '2.0.0');
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

test('a saved instance created by an older runtime package is replaced automatically', async (t) => {
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
  assert.deepEqual(fixture.state.stops, ['old-controller-instance']);
  assert.notEqual(connected.host.instanceId, 'old-controller-instance');
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === connected.host.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
  assert.equal(connected.host.lastServerVersion, '2.0.0');
});

test('an active Host on an older runtime package is replaced on the shared channel', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.1' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.connect(record.id);
  const shared = fixture.service.sessions.get(record.id).channel;
  fixture.setControllerVersion('0.2.2');
  const second = await fixture.service.connect(record.id);
  assert.notEqual(second.host.instanceId, first.host.instanceId);
  assert.deepEqual(fixture.state.stops, [first.host.instanceId]);
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === second.host.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
  assert.equal(shared.closed, false);
  assert.equal(fixture.service.sessions.get(record.id).channel, shared);
});

test('a profile Host on an older runtime package is replaced when reopened', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0', controllerVersion: '0.2.1' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const first = await fixture.service.webOpen(record.id, { profileId: 'work' });
  fixture.setControllerVersion('0.2.2');
  await fixture.service.disconnect(record.id);
  const second = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(fixture.state.stops, [first.instanceId]);
  assert.notEqual(second.instanceId, first.instanceId);
  const created = fixture.state.instances.find((entry) => entry.instance.instanceId === second.instanceId);
  assert.equal(created.instance.createdBy, fixture.runtimeIdFor('2.0.0', '0.2.2'));
});
