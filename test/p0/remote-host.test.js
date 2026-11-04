import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RemoteControllerClient } from '../../packages/manager/src/host/remote-controller.js';
import { RemoteHostConnection } from '../../packages/manager/src/host/remote-host.js';

test('controller adapter correlates requests and returns the command result', async () => {
  let request;
  const channel = {
    async execJson(value) {
      request = value;
      return {
        protocolVersion: value.protocolVersion,
        requestId: value.requestId,
        ok: true,
        result: { instances: [] },
      };
    },
  };
  const controller = new RemoteControllerClient({
    channel,
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  const result = await controller.list({ version: '0.2.1-rc.5', buildId: 'build-1' });
  assert.deepEqual(result, { instances: [] });
  assert.deepEqual(request.args.slice(0, 5), ['list', '--expected-version', '0.2.1-rc.5', '--expected-build-id', 'build-1']);
  assert.deepEqual(request.args.slice(-2), ['--request-id', request.requestId]);
});

test('controller adapter preserves structured remote failures', async () => {
  const controller = new RemoteControllerClient({
    channel: {
      async execJson(value) {
        return { protocolVersion: 1, requestId: value.requestId, ok: false, error: { code: 'REMOTE_VERSION_MISMATCH', message: 'version mismatch' } };
      },
    },
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  await assert.rejects(controller.list(), (error) => error.code === 'REMOTE_VERSION_MISMATCH');
});

test('remote host attaches, exposes a local browser URL, and releases its lease', async () => {
  const calls = [];
  const gateway = new EventEmitter();
  gateway.url = 'http://127.0.0.1:52000';
  gateway.listen = async () => {};
  gateway.close = async () => { calls.push('gateway.close'); };
  const channel = new EventEmitter();
  channel.closed = false;
  channel.createLoopbackGateway = () => gateway;
  const controller = {
    async list() { return { instances: [{ instance: { instanceId: 'instance-1' }, health: { healthy: true } }] }; },
    async attach(input) {
      calls.push(['attach', input]);
      return {
        instance: { instanceId: 'instance-1', endpoint: { host: '127.0.0.1', port: 41000 } },
        authenticatedUrl: 'http://127.0.0.1:41000/?tkn=secret-token',
        clientLeaseId: 'lease-1',
      };
    },
    async release(input) { calls.push(['release', input]); },
  };
  let requestCount = 0;
  const host = new RemoteHostConnection({
    channel, controller, version: '0.2.1-rc.5', buildId: 'build-1', workspace: '/home/test',
    async fetchImpl(_url, options) {
      requestCount += 1;
      if (requestCount === 1) return new Response(null, { status: 302, headers: { 'set-cookie': 'browser-credential=secret; Path=/' } });
      assert.equal(options.headers.cookie, 'browser-credential=secret');
      return Response.json({ ok: true, role: 'remote' });
    },
  });
  await host.open();
  assert.equal(host.browserUrl, 'http://127.0.0.1:52000/?tkn=secret-token');
  await host.close();
  assert.equal(host.browserUrl, null);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'release'), true);
  assert.equal(calls.includes('gateway.close'), true);
});
