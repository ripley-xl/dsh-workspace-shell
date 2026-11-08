import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture, waitFor, waitForPhase } from '../../p1/service/helpers.mjs';

async function connectedFixture(t, options = {}) {
  const fixture = await serviceFixture(options);
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  return { ...fixture, record };
}

/** A host whose SSH transport is open but which holds no Web Host yet. */
async function transportOnlyFixture(t, options = {}) {
  const fixture = await serviceFixture(options);
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const session = fixture.service.session(record.id);
  await fixture.service.ensureTransport(session, { interactive: false, background: true });
  return { ...fixture, record };
}

test('two web profiles share one SSH channel and controller but keep separate hosts', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const openSession = service.openControllerSession;
  let sessions = 0;
  service.openControllerSession = async (input) => {
    sessions += 1;
    return openSession(input);
  };
  const sharedChannel = service.sessions.get(record.id).channel;

  const web = await service.webOpen(record.id, { profileId: 'web' });
  const work = await service.webOpen(record.id, { profileId: 'work' });
  assert.equal(web.profileId, 'web');
  assert.equal(work.profileId, 'work');
  assert.notEqual(web.instanceId, work.instanceId);
  assert.match(web.url, /\?tkn=secret-/u);
  assert.match(work.url, /\?tkn=secret-/u);
  // Both profile hosts reuse the connection opened by the default connect.
  assert.equal(sessions, 0);
  const webRuntime = service.profileRuntime(record.id, 'web');
  const workRuntime = service.profileRuntime(record.id, 'work');
  assert.equal(webRuntime.host.channel, sharedChannel);
  assert.equal(workRuntime.host.channel, sharedChannel);
  assert.deepEqual(state.instances.map((entry) => entry.instance.profileId).sort(), ['web', 'work']);

  const hosts = service.profileHosts(record.id);
  assert.deepEqual(hosts.map((host) => [host.profileId, host.instanceId, host.state]), [
    ['web', web.instanceId, 'running'],
    ['work', work.instanceId, 'running'],
  ]);
  assert.equal(JSON.stringify(hosts).includes('tkn='), false);
  assert.equal(JSON.stringify(await service.status()).includes('tkn='), false);
});

test('opening the same profile twice reuses one healthy instance', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const first = await service.webOpen(record.id, { profileId: 'web' });
  const second = await service.webOpen(record.id, { profileId: 'web' });
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(second.url, first.url);
  assert.equal(state.instances.length, 1);
  const listed = await service.webList(record.id);
  assert.equal(listed.hosts.length, 1);
  assert.equal(listed.hosts[0].instanceId, first.instanceId);
});

test('concurrent opens of one profile wait on a single start', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  let resolveDelay;
  state.openDelay = () => new Promise((resolve) => { resolveDelay = resolve; });
  const pending = [service.webOpen(record.id, { profileId: 'web' }), service.webOpen(record.id, { profileId: 'web' })];
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveDelay();
  const [first, second] = await Promise.all(pending);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(state.instances.length, 1);
});

test('stopping one profile host keeps the other profile host running', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const web = await service.webOpen(record.id, { profileId: 'web' });
  const work = await service.webOpen(record.id, { profileId: 'work' });
  const stopped = await service.webStop(record.id, { instanceId: web.instanceId });
  assert.equal(stopped.instanceId, web.instanceId);
  assert.equal(stopped.profileId, 'web');
  assert.deepEqual(state.stops, [web.instanceId]);
  const hosts = service.profileHosts(record.id);
  assert.deepEqual(hosts.map((host) => host.profileId), ['work']);
  assert.equal(hosts[0].instanceId, work.instanceId);
  assert.equal(hosts[0].state, 'running');
  const reopened = await service.webOpen(record.id, { profileId: 'web' });
  assert.notEqual(reopened.instanceId, work.instanceId);
});

test('disconnect keeps remote instances and a later open attaches to them', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const web = await service.webOpen(record.id, { profileId: 'web' });
  const work = await service.webOpen(record.id, { profileId: 'work' });
  await service.disconnect(record.id);
  assert.deepEqual(state.stops, []);
  // Profiles stay recorded as offline so a reconnect attaches instead of guessing.
  assert.deepEqual(service.profileHosts(record.id).map((host) => [host.profileId, host.state]), [
    ['web', 'offline'],
    ['work', 'offline'],
  ]);
  assert.equal(service.profileHosts(record.id).every((host) => host.health.connected === false), true);
  assert.equal(service.publicConnection(record.id).phase, 'idle');
  const attached = await service.webAttach(record.id, { instanceId: work.instanceId });
  assert.equal(attached.instanceId, work.instanceId);
  assert.equal(attached.profileId, 'work');
  const reopened = await service.webOpen(record.id, { profileId: 'web' });
  assert.equal(reopened.instanceId, web.instanceId);
  assert.deepEqual(state.stops, []);
});

test('attach refuses an instance of another manager or an unknown profile', async (t) => {
  const { service, record } = await connectedFixture(t);
  await service.webOpen(record.id, { profileId: 'web' });
  await assert.rejects(service.webAttach(record.id, { instanceId: 'not-managed' }), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
  await assert.rejects(service.webAttach(record.id, {}), (error) => error.code === 'INVALID_REQUEST');
  assert.equal(service.profileHosts(record.id).length, 1);
});

test('web list reports controller profiles and never leaks host URLs', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  state.profiles = ['web', 'work', { id: 'tui-only', web: false }];
  await service.webOpen(record.id, { profileId: 'work' });
  const listed = await service.webList(record.id);
  assert.deepEqual(listed.profiles, [
    { id: 'tui-only', web: false },
    { id: 'web', web: true },
    { id: 'work', web: true },
  ]);
  assert.equal(listed.profilesSource, 'remote');
  assert.deepEqual(listed.hosts.map((host) => host.profileId), ['web', 'work']);
  assert.equal(JSON.stringify(listed).includes('tkn='), false);
  assert.equal(JSON.stringify(listed).includes('4100'), false);
  await assert.rejects(service.webOpen(record.id, { profileId: 'tui-only' }), (error) => error.code === 'PROFILE_NOT_WEB');
  await assert.rejects(service.webOpen(record.id, { profileId: 'not-listed' }), (error) => error.code === 'PROFILE_NOT_WEB');
});

test('profile listing falls back to the default web profile when the controller lacks profiles', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  state.profilesError = Object.assign(new Error('unknown command'), { code: 'INVALID_ARGUMENT' });
  const listed = await service.webList(record.id);
  assert.deepEqual(listed.profiles, [{ id: 'web', web: true }]);
  assert.equal(listed.profilesSource, 'default');
});

test('an empty remote profile list keeps the built-in default web available', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  state.profiles = [];
  const listed = await service.webList(record.id);
  assert.deepEqual(listed.profiles, [{ id: 'web', web: true }]);
  const opened = await service.webOpen(record.id, { profileId: 'web' });
  assert.equal(opened.profileId, 'web');
});

test('a failed start stays retryable and does not keep a broken host', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  state.instances.push({
    instance: { instanceId: 'stale-1', profileId: 'web', dshVersion: '1.0.0', buildId: 'build-1', endpoint: { host: '127.0.0.1', port: 41099 } },
    health: { healthy: false },
  });
  const Broken = service.RemoteHostConnection;
  let fail = true;
  service.RemoteHostConnection = class extends Broken {
    async open() {
      if (fail) throw Object.assign(new Error('attach failed'), { code: 'REMOTE_INSTANCE_UNAVAILABLE' });
      return super.open();
    }
  };
  await assert.rejects(service.webOpen(record.id, { profileId: 'web' }), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
  // A failed start records the error but never claims a Host it does not hold.
  assert.deepEqual(service.profileHosts(record.id), []);
  fail = false;
  const opened = await service.webOpen(record.id, { profileId: 'web' });
  assert.equal(opened.ok, true);
  assert.deepEqual(service.profileHosts(record.id).map((host) => [host.profileId, host.state]), [['web', 'running']]);
});

test('a cancelled open stops the host it created but keeps a reused one', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  const reuse = await service.webOpen(record.id, { profileId: 'work' });
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let openedCreated = false;
  const Base = service.RemoteHostConnection;
  service.RemoteHostConnection = class extends Base {
    async open() {
      await super.open();
      if (this.profileId === 'fresh') {
        openedCreated = true;
        await gate;
      }
      return this;
    }
  };
  const pending = service.webOpen(record.id, { profileId: 'fresh', signal: controller.signal });
  while (!openedCreated) await new Promise((resolve) => setTimeout(resolve, 2));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'OPERATION_CANCELLED');
  release();
  const created = state.instances.find((entry) => entry.instance.profileId === 'fresh');
  assert.ok(created);
  await waitFor(() => state.stops.includes(created.instance.instanceId));
  assert.equal(state.stops.includes(reuse.instanceId), false);
  assert.equal(service.profileHosts(record.id).length, 1);
  assert.equal(service.profileHosts(record.id)[0].instanceId, reuse.instanceId);
  service.RemoteHostConnection = Base;
  const retried = await service.webOpen(record.id, { profileId: 'fresh' });
  assert.equal(retried.ok, true);
  assert.equal(service.profileHosts(record.id).length, 2);
});

test('a cancel before any work starts creates nothing', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  const before = state.instances.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.webOpen(record.id, { profileId: 'web', signal: controller.signal }),
    (error) => error.code === 'OPERATION_CANCELLED',
  );
  assert.equal(state.instances.length, before);
  assert.deepEqual(state.stops, []);
  assert.equal(service.profileHosts(record.id).filter((host) => host.instanceId).length, 0);
});

test('one cancelled waiter does not abort the shared open for the others', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  const controller = new AbortController();
  state.openDelay = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const first = service.webOpen(record.id, { profileId: 'web', signal: controller.signal });
  const second = service.webOpen(record.id, { profileId: 'web' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(first, (error) => error.code === 'OPERATION_CANCELLED');
  const opened = await second;
  assert.equal(opened.ok, true);
  assert.equal(state.stops.length, 0);
  assert.equal(service.profileHosts(record.id).length, 1);
});

test('duplicate stop requests for one host run once', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const work = await service.webOpen(record.id, { profileId: 'work' });
  const first = service.webStop(record.id, { instanceId: work.instanceId });
  const second = service.webStop(record.id, { instanceId: work.instanceId });
  assert.equal(first, second);
  await first;
  assert.deepEqual(state.stops, [work.instanceId]);
});

test('autoConnect records connect in the background after service creation', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({
    hostAlias: 'p0-test', autoConnect: true, syncPolicy: { appearance: false },
  });
  assert.equal(record.autoConnect, true);
  const started = Date.now();
  await fixture.service.autoConnectAll();
  assert.ok(Date.now() - started < 500);
  await waitForPhase(fixture.service, record.id, 'connected');
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
  assert.equal(fixture.state.instances.length, 1);
});

test('toggling autoConnect off disconnects without stopping the remote instance', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const created = await fixture.service.upsert({ hostAlias: 'p0-test', autoConnect: true, syncPolicy: { appearance: false } });
  const record = { id: created.host.id };
  await waitForPhase(fixture.service, record.id, 'connected');
  const instanceId = fixture.service.publicConnection(record.id).instanceId;
  const updated = await fixture.service.upsert({ id: record.id, autoConnect: false });
  assert.equal(updated.host.autoConnect, false);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'idle');
  assert.deepEqual(fixture.state.stops, []);
  const instance = fixture.state.instances.find((entry) => entry.instance.instanceId === instanceId);
  assert.equal(instance.health.healthy, true);
});

test('toggling autoConnect on connects in the background', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  assert.equal(record.autoConnect, false);
  await fixture.service.upsert({ id: record.id, autoConnect: true });
  await waitForPhase(fixture.service, record.id, 'connected');
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
});

test('existing hosts keep autoConnect=false and legacy records stay readable', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test' });
  assert.equal(record.autoConnect, false);
  assert.equal(fixture.service.publicConnection(record.id).autoConnect, false);
});

test('a legacy stop keeps the shared transport usable for other profile hosts', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const work = await service.webOpen(record.id, { profileId: 'work' });
  const defaultInstance = service.publicConnection(record.id).instanceId;
  const shared = service.sessions.get(record.id).channel;
  const stopped = await service.stop(record.id, { instanceId: defaultInstance });
  assert.equal(stopped.stoppedInstanceId, defaultInstance);
  assert.deepEqual(state.stops, [defaultInstance]);
  const session = service.sessions.get(record.id);
  assert.equal(session.connected, true);
  assert.equal(session.channel, shared);
  assert.deepEqual(service.profileHosts(record.id).map((host) => [host.profileId, host.state]), [['work', 'running']]);
  assert.equal(service.profileHosts(record.id)[0].instanceId, work.instanceId);
  const listed = await service.webList(record.id);
  assert.equal(listed.connected, true);
});

test('disconnect is idempotent and never stops remote hosts', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  await service.webOpen(record.id, { profileId: 'work' });
  await service.disconnect(record.id);
  await service.disconnect(record.id);
  assert.deepEqual(state.stops, []);
  assert.equal(service.publicConnection(record.id).phase, 'idle');
  await service.webOpen(record.id, { profileId: 'work' });
  assert.deepEqual(state.stops, []);
});

test('stopping an offline profile host reconnects and leaves the others alone', async (t) => {
  const { service, record, state } = await connectedFixture(t);
  const web = await service.webOpen(record.id, { profileId: 'web' });
  const work = await service.webOpen(record.id, { profileId: 'work' });
  await service.disconnect(record.id);
  assert.deepEqual(service.profileHosts(record.id).map((host) => host.state), ['offline', 'offline']);
  const stopped = await service.webStop(record.id, { instanceId: work.instanceId });
  assert.equal(stopped.profileId, 'work');
  assert.deepEqual(state.stops, [work.instanceId]);
  assert.deepEqual(service.profileHosts(record.id).map((host) => [host.profileId, host.state]), [['web', 'offline']]);
  const reopened = await service.webOpen(record.id, { profileId: 'web', reuseOnly: true });
  assert.equal(reopened.instanceId, web.instanceId);
});

test('a profile Host start writes the status-plugin patch before it starts', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  const opened = await service.webOpen(record.id, { profileId: 'web' });
  assert.equal(opened.ok, true);
  const start = state.starts.at(-1);
  assert.ok(start, 'the controller start should carry the profile Host request');
  assert.match(start.patch, /\/home\/test\/\.dsh\/ssh-remote\/tmp\/status-[0-9a-f-]+\.yml$/u);
  const tee = state.execs.find((entry) => entry.command === 'tee' && entry.args?.[0] === start.patch);
  assert.ok(tee, 'the patch file must be written over the SSH channel');
  assert.match(tee.input, /ssh-remote-status/u);
  assert.match(tee.input, /"p0-test"/u);
  assert.match(tee.input, /127\.0\.0\.1:54542/u);
  assert.equal(state.hosts.at(-1).patch, start.patch);
});

test('a failed profile Host start stops the instance it created', async (t) => {
  const { service, record, state } = await transportOnlyFixture(t);
  state.failOpenAfterAttach = true;
  await assert.rejects(service.webOpen(record.id, { profileId: 'web' }), (error) => {
    assert.equal(error.message, 'simulated status check failure');
    return true;
  });
  const created = state.instances.at(-1).instance.instanceId;
  assert.deepEqual(state.stops, [created]);
});

test('a failure keeps the original error message instead of [object Object]', async (t) => {
  const { service, record } = await transportOnlyFixture(t);
  const runtime = service.profileRuntime(record.id, 'web');
  runtime.instanceId = 'instance-lost';
  runtime.error = { code: 'REMOTE_OPERATION_FAILED', message: 'attach failed before status check' };
  const [host] = service.profileHosts(record.id);
  assert.deepEqual(host.error, { code: 'REMOTE_OPERATION_FAILED', message: 'attach failed before status check' });
});
