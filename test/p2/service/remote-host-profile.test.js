import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RemoteHostConnection } from '../../../packages/manager/src/host/remote-host.js';

function gateway() {
  const value = new EventEmitter();
  value.url = 'http://127.0.0.1:52000';
  value.listen = async () => {};
  value.close = async () => {};
  return value;
}

function channel() {
  const value = new EventEmitter();
  value.closed = false;
  value.createLoopbackGateway = () => gateway();
  return value;
}

function controllerRecorder(entries) {
  const calls = [];
  return {
    calls,
    async list(input) {
      calls.push(['list', input]);
      return { instances: entries.filter((entry) => (input.profileId === undefined
        || (entry.instance.profileId ?? 'web') === input.profileId)) };
    },
    async start(input) {
      calls.push(['start', input]);
      const instance = { instanceId: 'started-1', profileId: input.profileId, endpoint: { host: '127.0.0.1', port: 41001 } };
      entries.push({ instance, health: { healthy: true } });
      return { instance };
    },
    async attach(input) {
      calls.push(['attach', input]);
      const entry = entries.find((candidate) => candidate.instance.instanceId === input.instanceId);
      return {
        instance: entry.instance,
        authenticatedUrl: `http://127.0.0.1:${entry.instance.endpoint.port}/?tkn=secret-${input.instanceId}`,
        clientLeaseId: `lease-${input.instanceId}`,
      };
    },
    async release(input) { calls.push(['release', input]); },
    async heartbeat(input) { return input; },
  };
}

function hosting(controller, extra = {}) {
  return new RemoteHostConnection({
    channel: channel(),
    controller,
    version: '1.0.0',
    buildId: 'build-1',
    workspace: '/home/test',
    async fetchImpl(_url, options) {
      if (!options?.headers?.cookie) {
        return new Response(null, { status: 302, headers: { 'set-cookie': 'credential=secret; Path=/' } });
      }
      return Response.json({ ok: true, role: 'remote' });
    },
    ...extra,
  });
}

test('a profile host only reuses the healthy instance of that profile', async () => {
  const entries = [
    { instance: { instanceId: 'web-1', profileId: 'web', endpoint: { host: '127.0.0.1', port: 41000 } }, health: { healthy: true } },
    { instance: { instanceId: 'work-1', profileId: 'work', endpoint: { host: '127.0.0.1', port: 41002 } }, health: { healthy: true } },
  ];
  const controller = controllerRecorder(entries);
  const host = hosting(controller, { profileId: 'work' });
  await host.open();
  assert.equal(host.instanceId, 'work-1');
  assert.equal(host.profileId, 'work');
  const attach = controller.calls.find(([name]) => name === 'attach');
  assert.equal(attach[1].profileId, 'work');
  assert.equal(attach[1].instanceId, 'work-1');
  assert.equal(controller.calls.some(([name]) => name === 'start'), false);
  await host.close();
});

test('a legacy instance record without profileId is read as web', async () => {
  const entries = [
    { instance: { instanceId: 'legacy-1', endpoint: { host: '127.0.0.1', port: 41000 } }, health: { healthy: true } },
  ];
  const controller = controllerRecorder(entries);
  const host = hosting(controller);
  await host.open();
  assert.equal(host.instanceId, 'legacy-1');
  assert.equal(host.profileId, 'web');
  await host.close();
});

test('reuse-only mode refuses to start a new instance and never touches another profile', async () => {
  const entries = [
    { instance: { instanceId: 'web-1', profileId: 'web', endpoint: { host: '127.0.0.1', port: 41000 } }, health: { healthy: true } },
  ];
  const controller = controllerRecorder(entries);
  const host = hosting(controller, { profileId: 'work', startMode: 'reuse-only' });
  await assert.rejects(host.open(), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
  assert.equal(controller.calls.some(([name]) => name === 'start'), false);
  assert.equal(controller.calls.some(([name]) => name === 'attach'), false);
  assert.equal(host.closed, true);
});

test('a start that reports another profile is refused before attach', async () => {
  const controller = {
    async list() { return { instances: [] }; },
    async start() { return { instance: { instanceId: 'wrong-1', profileId: 'web', endpoint: { host: '127.0.0.1', port: 41000 } } }; },
    async attach() { throw new Error('attach must not run'); },
    async release() {},
    async heartbeat() {},
  };
  const host = hosting(controller, { profileId: 'work' });
  await assert.rejects(host.open(), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
});

test('an attach that reports another profile is refused', async () => {
  const controller = {
    async list() {
      return { instances: [{ instance: { instanceId: 'work-1', profileId: 'work', endpoint: { host: '127.0.0.1', port: 41000 } }, health: { healthy: true } }] };
    },
    async start() { throw new Error('start must not run'); },
    async attach() {
      return {
        instance: { instanceId: 'work-1', profileId: 'web', endpoint: { host: '127.0.0.1', port: 41000 } },
        authenticatedUrl: 'http://127.0.0.1:41000/?tkn=secret',
        clientLeaseId: 'lease-1',
      };
    },
    async release() {},
    async heartbeat() {},
  };
  const host = hosting(controller, { profileId: 'work' });
  await assert.rejects(host.open(), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
});
