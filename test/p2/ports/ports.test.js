import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { PortForwardManager } from '../../../packages/shell/ssh-remote/src/host/ports.js';
import { SshControlChannel } from '../../../packages/shell/ssh-remote/src/host/ssh/control-channel.js';

async function listen(server, port = 0) {
  server.listen({ host: '127.0.0.1', port });
  await once(server, 'listening');
  return server.address().port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

class ForwardingClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  forwardOut(sourceHost, sourcePort, targetHost, targetPort, callback) {
    this.calls.push({ sourceHost, sourcePort, targetHost, targetPort });
    const channel = net.connect({ host: targetHost, port: targetPort });
    let completed = false;
    channel.once('connect', () => {
      completed = true;
      callback(null, channel);
    });
    channel.once('error', (error) => {
      if (!completed) callback(error);
    });
  }

  end() {
    queueMicrotask(() => this.emit('close'));
  }

  destroy() {}
}

async function fixture(t) {
  const remote = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const remotePort = await listen(remote);
  const client = new ForwardingClient();
  const channel = new SshControlChannel(client, {});
  const manager = new PortForwardManager(channel);
  t.after(async () => {
    await manager.closeAll();
    await channel.close();
    await closeServer(remote);
  });
  return { channel, client, manager, remote, remotePort };
}

function exchange(port, payload, { halfClose = true } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      if (halfClose) socket.end(payload);
      else socket.write(payload);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => resolve({ chunks: Buffer.concat(chunks), socket }));
    socket.once('error', reject);
  });
}

async function waitFor(predicate, message = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}.`);
}

async function assertClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
}

test('add allocates a loopback port and forwards bytes only to the fixed remote target', async (t) => {
  const { client, manager, remotePort } = await fixture(t);
  const forward = await manager.add({ name: '  Remote web  ', remotePort });
  assert.equal(forward.name, 'Remote web');
  assert.equal(forward.state, 'active');
  assert.equal(forward.localHost, '127.0.0.1');
  assert.equal(forward.remoteHost, '127.0.0.1');
  assert.equal(forward.remotePort, remotePort);
  assert.ok(forward.localPort > 0);
  assert.match(forward.id, /^[a-f0-9-]{36}$/iu);

  const payload = Buffer.from('GET / HTTP/1.1\r\nCookie: opaque\r\n\r\n');
  const response = await exchange(forward.localPort, payload);
  assert.deepEqual(response.chunks, payload);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].sourceHost, '127.0.0.1');
  assert.equal(client.calls[0].targetHost, '127.0.0.1');
  assert.equal(client.calls[0].targetPort, remotePort);

  const listed = manager.list();
  assert.deepEqual(listed, [forward]);
  listed[0].localPort = 1;
  assert.equal(manager.list()[0].localPort, forward.localPort);
});

test('concurrent adds have unique IDs and independent loopback listeners', async (t) => {
  const { manager, remotePort } = await fixture(t);
  const forwards = await Promise.all(Array.from({ length: 12 }, (_, index) => manager.add({
    name: `forward-${index}`,
    remotePort,
  })));
  assert.equal(new Set(forwards.map((forward) => forward.id)).size, forwards.length);
  assert.equal(new Set(forwards.map((forward) => forward.localPort)).size, forwards.length);
  const replies = await Promise.all(forwards.map((forward, index) => exchange(forward.localPort, `message-${index}`)));
  assert.deepEqual(replies.map((reply) => reply.chunks.toString()), forwards.map((_, index) => `message-${index}`));
  const closed = await manager.closeAll();
  assert.ok(closed.every((forward) => forward.state === 'closed'));
  assert.ok(manager.list().every((forward) => forward.state === 'closed'));
});

test('a specified local port is used and a bind failure cleans up its gateway', async (t) => {
  const { channel, manager, remotePort } = await fixture(t);
  const localPort = await unusedPort();
  const first = await manager.add({ localPort, remotePort });
  assert.equal(first.localPort, localPort);
  assert.equal((await exchange(localPort, 'fixed')).chunks.toString(), 'fixed');

  await assert.rejects(manager.add({ localPort, remotePort }), (error) => {
    assert.equal(error.code, 'TUNNEL_FAILED');
    return true;
  });
  assert.deepEqual(manager.list().map((forward) => forward.state), ['active', 'failed']);
  assert.equal(channel.gateways.size, 1);
  const failed = manager.list()[1];
  const removedFailure = await manager.remove(failed.id);
  assert.equal(removedFailure.state, 'closed');
  assert.deepEqual(manager.list().map((forward) => forward.id), [first.id]);

  const removed = await manager.remove(first.id);
  assert.equal(removed.state, 'closed');
  assert.equal(manager.list().length, 0);
  assert.equal(await manager.remove(first.id), null);
  assert.equal(channel.gateways.size, 0);
  await assertClosed(localPort);
});

test('non-loopback endpoints and invalid ports are rejected before allocation', async (t) => {
  const { manager, remotePort } = await fixture(t);
  for (const options of [
    { localHost: '0.0.0.0', remotePort },
    { localHost: '::1', remotePort },
    { remoteHost: 'example.com', remotePort },
    { targetHost: '192.168.1.2', remotePort },
    { localPort: -1, remotePort },
    { localPort: 65_536, remotePort },
    { localPort: 1.5, remotePort },
    { remotePort: 0 },
    { remotePort: 65_536 },
    { remotePort: '22' },
  ]) {
    await assert.rejects(manager.add(options));
  }
  assert.deepEqual(manager.list(), []);
});

test('SSH disconnect closes listeners, sockets, and channel-owned gateways', async (t) => {
  const { channel, client, manager, remotePort } = await fixture(t);
  const forward = await manager.add({ remotePort });
  const socket = net.connect({ host: '127.0.0.1', port: forward.localPort });
  socket.on('error', () => {});
  await once(socket, 'connect');
  await waitFor(() => client.calls.length === 1, 'direct-tcpip channel');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  client.emit('close');
  await socketClosed;
  await waitFor(() => manager.closed && manager.list()[0]?.state === 'closed', 'disconnect cleanup');
  assert.equal(channel.gateways.size, 0);
  await assertClosed(forward.localPort);
  await assert.rejects(manager.add({ remotePort }), { code: 'TUNNEL_FAILED' });
});

test('concurrent remove and closeAll are idempotent and remove active sockets', async (t) => {
  const { manager, remotePort } = await fixture(t);
  const first = await manager.add({ remotePort });
  const second = await manager.add({ remotePort });
  const socket = net.connect({ host: '127.0.0.1', port: first.localPort });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  const removals = await Promise.all([manager.remove(first.id), manager.remove(first.id)]);
  assert.ok(removals.every((forward) => forward?.state === 'closed'));
  await socketClosed;
  assert.deepEqual(manager.list().map((forward) => forward.id), [second.id]);
  const all = await Promise.all([manager.closeAll(), manager.closeAll()]);
  assert.equal(all[1][0].state, 'closed');
  assert.equal(manager.list()[0].state, 'closed');
  await assert.rejects(manager.add({ remotePort }), { code: 'TUNNEL_FAILED' });
});

test('closeAll during listen rejects the pending add without leaking a listener', async (t) => {
  const { channel, manager, remotePort } = await fixture(t);
  let resolveListen;
  const gateway = new EventEmitter();
  gateway.listenCalls = 0;
  gateway.closeCalls = 0;
  gateway.listen = () => {
    gateway.listenCalls += 1;
    return new Promise((resolve) => { resolveListen = resolve; });
  };
  gateway.close = async () => {
    if (gateway.closeCalls) return;
    gateway.closeCalls += 1;
    gateway.emit('close');
  };
  const pendingManager = new PortForwardManager(channel, { gatewayFactory: () => gateway });
  t.after(() => pendingManager.closeAll());
  const adding = pendingManager.add({ remotePort });
  const rejection = assert.rejects(adding, { code: 'TUNNEL_FAILED' });
  await waitFor(() => gateway.listenCalls === 1, 'pending listen');
  await pendingManager.closeAll();
  resolveListen({ host: '127.0.0.1', port: 43210 });
  await rejection;
  assert.equal(gateway.closeCalls, 1);
  assert.equal(pendingManager.list()[0].state, 'closed');
  await manager.closeAll();
});

test('explicit control-channel close cleans up managed forwards', async (t) => {
  const { channel, manager, remotePort } = await fixture(t);
  const forward = await manager.add({ remotePort });
  await channel.close();
  await waitFor(() => manager.list()[0]?.state === 'closed', 'channel close cleanup');
  assert.equal(manager.closed, true);
  assert.equal(channel.gateways.size, 0);
  await assertClosed(forward.localPort);
});

test('closeAll during a real TCP listen waits for cleanup and rejects the add', async (t) => {
  const { channel, manager, remotePort } = await fixture(t);
  const adding = manager.add({ remotePort });
  const rejection = assert.rejects(adding, { code: 'TUNNEL_FAILED' });
  const closing = manager.closeAll();
  await Promise.all([rejection, closing]);
  assert.equal(manager.list()[0].state, 'closed');
  assert.equal(channel.gateways.size, 0);
});

test('a data-channel error is reported without taking down other forwards', async (t) => {
  const { client, manager, remotePort } = await fixture(t);
  const first = await manager.add({ remotePort });
  const second = await manager.add({ remotePort });
  const original = client.forwardOut.bind(client);
  let fail = true;
  client.forwardOut = (...args) => {
    if (!fail) return original(...args);
    fail = false;
    const callback = args.at(-1);
    queueMicrotask(() => callback(new Error('administratively prohibited')));
  };
  const failure = once(manager, 'forwardError');
  const socket = net.connect({ host: '127.0.0.1', port: first.localPort });
  socket.on('error', () => {});
  const [event] = await failure;
  assert.equal(event.id, first.id);
  assert.equal(event.error.code, 'TUNNEL_FAILED');
  assert.equal(manager.list().find((forward) => forward.id === first.id).state, 'active');
  assert.equal((await exchange(second.localPort, 'still-open')).chunks.toString(), 'still-open');
});
