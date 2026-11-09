import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { addPortForward, createRemoteDiagnosticReport, listPortForwards, removePortForward } from '../../../packages/manager/src/host/service-extensions.js';
import { SshControlChannel } from '../../../packages/manager/src/host/ssh/control-channel.js';

async function tcpServer(handler) {
  const server = net.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('service extensions add, use, remove and diagnose a real local TCP forward', async (t) => {
  const echo = await tcpServer((socket) => socket.pipe(socket));
  const client = new EventEmitter();
  client.forwardOut = (_sourceHost, _sourcePort, _targetHost, targetPort, callback) => {
    callback(null, net.connect({ host: '127.0.0.1', port: targetPort }));
  };
  client.end = () => {};
  client.destroy = () => {};
  const channel = new SshControlChannel(client, {});
  const runtime = {
    hostId: 'host-1', channel,
    host: { closed: false, instanceId: 'instance-1', version: '1.0.0', buildId: 'build-1' },
    controller: {
      async logs({ stream }) {
        return { text: `token=secret-token ${stream}`, hasMore: false, nextOffset: 10 };
      },
    },
    phase: 'connected', sync: null, error: null,
  };
  const service = {
    runtime: () => runtime,
    store: { require: () => ({ id: 'host-1' }) },
    publicConnection: () => ({ id: 'host-1', portForwards: runtime.portForwards ?? [] }),
    localVersion: async () => '1.0.0',
    publish: () => {},
  };
  t.after(async () => {
    await channel.close();
    await new Promise((resolve) => echo.server.close(resolve));
  });

  const forward = await addPortForward(service, 'host-1', { remotePort: echo.port, localPort: 0 });
  assert.equal(forward.state, 'active');
  assert.equal(listPortForwards(service, 'host-1').length, 1);
  const socket = net.connect({ host: '127.0.0.1', port: forward.localPort });
  await new Promise((resolve) => socket.once('connect', resolve));
  const received = new Promise((resolve) => socket.once('data', resolve));
  socket.write('port-forward-test');
  assert.equal((await received).toString(), 'port-forward-test');
  socket.destroy();

  const diagnostic = await createRemoteDiagnosticReport(service, 'host-1');
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.text.includes('secret-token'), false);
  assert.equal(diagnostic.report.controllerLogs.length, 2);

  const removed = await removePortForward(service, 'host-1', forward.id);
  assert.equal(removed.state, 'closed');
  assert.equal(listPortForwards(service, 'host-1').length, 0);
});

test('profile web hosts share the SSH channel and its port forward set', async (t) => {
  const { serviceFixture } = await import('../../p1/service/helpers.mjs');
  const { addPortForward, listPortForwards } = await import('../../../packages/manager/src/host/service-extensions.js');
  const echo = await tcpServer((socket) => socket.pipe(socket));
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const web = await fixture.service.webOpen(record.id, { profileId: 'web' });
  const work = await fixture.service.webOpen(record.id, { profileId: 'work' });
  assert.notEqual(web.instanceId, work.instanceId);
  const runtime = fixture.service.runtime(record.id);
  assert.equal(runtime.channel, fixture.service.profileRuntime(record.id, 'web').host.channel);
  assert.equal(runtime.channel, fixture.service.profileRuntime(record.id, 'work').host.channel);

  const forward = await addPortForward(fixture.service, record.id, { remotePort: echo.port, localPort: 0 });
  assert.equal(forward.state, 'active');
  assert.equal(listPortForwards(fixture.service, record.id).length, 1);
  const socket = net.connect({ host: '127.0.0.1', port: forward.localPort });
  t.after(async () => {
    socket.destroy();
    echo.server.closeAllConnections?.();
    await new Promise((resolve) => echo.server.close(resolve));
  });
  await new Promise((resolve) => socket.once('connect', resolve));
  const received = new Promise((resolve) => socket.once('data', resolve));
  socket.write('shared-channel');
  assert.equal((await received).toString(), 'shared-channel');

  await fixture.service.webStop(record.id, { instanceId: work.instanceId });
  assert.equal(fixture.service.profileHosts(record.id).length, 1);
  assert.equal(listPortForwards(fixture.service, record.id).length, 1);
  await fixture.service.webStop(record.id, { instanceId: web.instanceId });
  assert.equal(fixture.service.profileHosts(record.id).length, 0);
  assert.equal(listPortForwards(fixture.service, record.id).length, 1);
});
