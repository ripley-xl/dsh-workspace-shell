import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { LoopbackGateway } from '../../../packages/shell/ssh-remote/src/host/ssh/gateway.js';

async function delayedEchoServer() {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      setTimeout(() => {
        if (!socket.destroyed) socket.write(chunk);
      }, 100);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function clientTo(port) {
  const client = new EventEmitter();
  client.forwardOut = (_sourceHost, _sourcePort, _targetHost, _targetPort, callback) => {
    callback(null, net.connect({ host: '127.0.0.1', port }));
  };
  return client;
}

test('a slow data channel preserves every byte and completes without duplicate writes', async (t) => {
  const echo = await delayedEchoServer();
  const client = clientTo(echo.port);
  const gateway = new LoopbackGateway(client, { remotePort: echo.port });
  await gateway.listen();
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => echo.server.close(resolve));
  });

  const socket = net.connect({ host: '127.0.0.1', port: gateway.address.port });
  await new Promise((resolve) => socket.once('connect', resolve));
  const expected = Buffer.alloc(256 * 1024);
  for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
  const chunks = [];
  const received = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length === expected.length) resolve();
    });
  });
  const started = Date.now();
  socket.write(expected);
  await received;
  assert.ok(Date.now() - started >= 90);
  assert.deepEqual(Buffer.concat(chunks), expected);
  socket.destroy();
});

test('an interrupted slow channel closes the local socket and gateway listeners', async (t) => {
  const echo = await delayedEchoServer();
  const client = clientTo(echo.port);
  const gateway = new LoopbackGateway(client, { remotePort: echo.port });
  await gateway.listen();
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => echo.server.close(resolve));
  });

  const socket = net.connect({ host: '127.0.0.1', port: gateway.address.port });
  await new Promise((resolve) => socket.once('connect', resolve));
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.on('error', () => {});
  socket.write('pending-response');
  client.emit('close');
  await closed;
  assert.equal(gateway.closed, true);
  assert.equal(gateway.connections.size, 0);
});
