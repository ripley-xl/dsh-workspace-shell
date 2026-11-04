import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { LoopbackGateway } from '../../../packages/shell/ssh-remote/src/host/ssh/gateway.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function echoServer(t) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

class ForwardingClient extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.calls = [];
  }

  forwardOut(sourceHost, sourcePort, targetHost, targetPort, callback) {
    this.calls.push({ sourceHost, sourcePort, targetHost, targetPort });
    const channel = net.connect({ host: this.port === targetPort ? '127.0.0.1' : '127.0.0.1', port: targetPort });
    channel.once('connect', () => callback(null, channel));
    channel.once('error', (error) => callback(error));
  }
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

test('LoopbackGateway binds only IPv4 loopback and preserves HTTP/WebSocket bytes', async (t) => {
  const remotePort = await echoServer(t);
  const client = new ForwardingClient(remotePort);
  const gateway = new LoopbackGateway(client, { remotePort });
  t.after(() => gateway.close());
  const address = await gateway.listen();
  assert.equal(address.host, '127.0.0.1');
  assert.notEqual(address.port, remotePort);

  const payload = Buffer.concat([
    Buffer.from(
      'GET /socket?token=opaque HTTP/1.1\r\n'
      + 'Host: localhost:12345\r\n'
      + 'Origin: http://localhost:12345\r\n'
      + 'Cookie: dsh=opaque\r\n'
      + 'Upgrade: websocket\r\n\r\n',
    ),
    Buffer.from([0x81, 0x80, 0x00, 0xff, 0x00, 0x7f]),
  ]);
  const response = await exchange(address.port, payload);
  assert.deepEqual(response.chunks, payload);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].sourceHost, '127.0.0.1');
  assert.equal(client.calls[0].targetHost, '127.0.0.1');
  assert.equal(client.calls[0].targetPort, remotePort);
});

test('LoopbackGateway uses one direct-tcpip channel per TCP connection', async (t) => {
  const remotePort = await echoServer(t);
  const client = new ForwardingClient(remotePort);
  const gateway = new LoopbackGateway(client, { remotePort });
  t.after(() => gateway.close());
  const { port } = await gateway.listen();
  const responses = await Promise.all([
    exchange(port, Buffer.from('first')),
    exchange(port, Buffer.from('second')),
    exchange(port, Buffer.from('third')),
  ]);
  assert.deepEqual(responses.map((response) => response.chunks.toString()), ['first', 'second', 'third']);
  assert.equal(client.calls.length, 3);
});

test('LoopbackGateway piping handles backpressure without changing bytes', async (t) => {
  const remotePort = await echoServer(t);
  const client = new ForwardingClient(remotePort);
  const gateway = new LoopbackGateway(client, { remotePort });
  t.after(() => gateway.close());
  const { port } = await gateway.listen();
  const payload = Buffer.alloc(2 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 253;
  const response = await exchange(port, payload);
  assert.deepEqual(response.chunks, payload);
});

test('forwardOut failures close only the affected socket with TUNNEL_FAILED', async (t) => {
  class FailedClient extends EventEmitter {
    forwardOut(sourceHost, sourcePort, targetHost, targetPort, callback) {
      queueMicrotask(() => callback(new Error('administratively prohibited')));
    }
  }
  const client = new FailedClient();
  const gateway = new LoopbackGateway(client, { remotePort: 22 });
  const { port } = await gateway.listen();
  const failure = once(gateway, 'gatewayError');
  const socket = net.connect({ host: '127.0.0.1', port });
  const [error] = await failure;
  assert.equal(error.code, 'TUNNEL_FAILED');
  await new Promise((resolve) => socket.once('close', resolve));
  await gateway.close();
});

test('closing during forwardOut destroys the socket and any late channel', async () => {
  class PendingClient extends EventEmitter {
    forwardOut(sourceHost, sourcePort, targetHost, targetPort, callback) {
      this.callback = callback;
      this.emit('forwarding');
    }
  }
  const client = new PendingClient();
  const gateway = new LoopbackGateway(client, { remotePort: 22 });
  const { port } = await gateway.listen();
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(client, 'forwarding');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await gateway.close();
  await socketClosed;

  const channel = new EventEmitter();
  channel.destroyed = false;
  channel.destroy = () => {
    channel.destroyed = true;
  };
  client.callback(null, channel);
  assert.equal(channel.destroyed, true);
});

test('a pending direct-tcpip request times out and closes its socket', async () => {
  class PendingClient extends EventEmitter {
    forwardOut() {}
  }
  const client = new PendingClient();
  const gateway = new LoopbackGateway(client, { channelTimeoutMs: 5, remotePort: 22 });
  const { port } = await gateway.listen();
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const failure = once(gateway, 'gatewayError');
  const [error] = await failure;
  assert.equal(error.code, 'OPERATION_TIMEOUT');
  await new Promise((resolve) => socket.once('close', resolve));
  await gateway.close();
});

test('SSH disconnect and explicit close destroy sockets and stop listening', async (t) => {
  const remotePort = await echoServer(t);
  const client = new ForwardingClient(remotePort);
  const gateway = new LoopbackGateway(client, { remotePort });
  const { port } = await gateway.listen();
  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.on('error', () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  const gatewayClosed = once(gateway, 'close');
  client.emit('close');
  await Promise.all([socketClosed, gatewayClosed]);
  assert.equal(gateway.address, null);
  await gateway.close();
  await assert.rejects(new Promise((resolve, reject) => {
    const replacement = net.connect({ host: '127.0.0.1', port });
    replacement.once('connect', () => {
      replacement.destroy();
      resolve();
    });
    replacement.once('error', reject);
  }), { code: 'ECONNREFUSED' });
});

test('LoopbackGateway rejects invalid or caller-selected remote targets', () => {
  const client = new ForwardingClient(22);
  assert.throws(() => new LoopbackGateway(client, { remotePort: 0 }), /remote port/u);
  assert.throws(() => new LoopbackGateway(client, { remotePort: 70000 }), /remote port/u);
});
