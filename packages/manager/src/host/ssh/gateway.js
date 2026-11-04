import { EventEmitter } from 'node:events';
import net from 'node:net';

import { SshRemoteError, operationTimeout } from './errors.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000;

function tunnelError(message, cause) {
  return new SshRemoteError('TUNNEL_FAILED', message, { cause });
}

function validatePort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('The fixed remote port must be an integer from 1 to 65535.');
  }
}

export class LoopbackGateway extends EventEmitter {
  constructor(client, options = {}) {
    super();
    if (!client || typeof client.forwardOut !== 'function') {
      throw new TypeError('A connected ssh2 client is required.');
    }
    validatePort(options.remotePort);
    this.client = client;
    this.remotePort = options.remotePort;
    this.channelTimeoutMs = options.channelTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.channelTimeoutMs) || this.channelTimeoutMs < 1) {
      throw new TypeError('The direct-tcpip channel timeout must be a positive integer.');
    }
    this.connections = new Set();
    this.closed = false;
    this.listening = false;
    this.closePromise = undefined;
    this.listenPromise = undefined;
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server.on('clientError', (error, socket) => {
      socket.destroy();
      this.report(error);
    });
    this.server.on('error', (error) => this.report(error));
    this.onClientClose = () => {
      void this.close();
    };
    client.once('close', this.onClientClose);
  }

  get address() {
    const address = this.server.address();
    if (!address || typeof address === 'string') return null;
    return { host: address.address, port: address.port };
  }

  get url() {
    const address = this.address;
    return address ? `http://${address.host}:${address.port}` : null;
  }

  async listen() {
    if (this.closed) throw tunnelError('The loopback gateway is closed.');
    if (this.listening) return this.address;
    if (this.listenPromise) return this.listenPromise;

    this.listenPromise = new Promise((resolve, reject) => {
      const onListening = () => {
        cleanup();
        this.listening = true;
        resolve(this.address);
      };
      const onError = (error) => {
        cleanup();
        reject(tunnelError('The loopback gateway could not start.', error));
      };
      const cleanup = () => {
        this.server.off('listening', onListening);
        this.server.off('error', onError);
      };
      this.server.once('listening', onListening);
      this.server.once('error', onError);
      try {
        this.server.listen({ host: LOOPBACK_HOST, port: 0 });
      } catch (error) {
        onError(error);
      }
    });
    return this.listenPromise;
  }

  report(error) {
    if (this.closed || ['ECONNRESET', 'EPIPE'].includes(error?.code)) return;
    this.emit('gatewayError', error instanceof SshRemoteError
      ? error
      : tunnelError('A loopback gateway connection failed.', error));
  }

  accept(socket) {
    if (this.closed || !this.listening) {
      socket.destroy();
      return;
    }
    const connection = { channel: undefined, socket, timer: undefined };
    this.connections.add(connection);
    socket.once('close', () => this.cleanupConnection(connection, true));
    socket.on('error', (error) => this.report(error));

    connection.timer = setTimeout(() => {
      this.report(operationTimeout('The SSH direct-tcpip channel timed out.'));
      this.cleanupConnection(connection, true);
    }, this.channelTimeoutMs);
    connection.timer.unref?.();

    try {
      this.client.forwardOut(
        LOOPBACK_HOST,
        socket.remotePort,
        LOOPBACK_HOST,
        this.remotePort,
        (error, channel) => {
          clearTimeout(connection.timer);
          if (this.closed || !this.connections.has(connection)) {
            channel?.destroy();
            socket.destroy();
            return;
          }
          if (error) {
            this.report(tunnelError('The SSH direct-tcpip channel could not be opened.', error));
            this.cleanupConnection(connection, true);
            return;
          }
          connection.channel = channel;
          channel.once('close', () => {
            connection.channel = undefined;
            if (!socket.destroyed) socket.end();
          });
          channel.once('error', (channelError) => {
            this.report(channelError);
            this.cleanupConnection(connection, true);
          });
          socket.pipe(channel);
          channel.pipe(socket);
        },
      );
    } catch (error) {
      this.report(tunnelError('The SSH direct-tcpip channel could not be opened.', error));
      this.cleanupConnection(connection, true);
    }
  }

  cleanupConnection(connection, destroy) {
    clearTimeout(connection.timer);
    if (!this.connections.delete(connection)) {
      if (destroy) {
        connection.channel?.destroy();
        connection.socket.destroy();
      }
      return;
    }
    if (destroy) {
      connection.channel?.destroy();
      connection.socket.destroy();
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listening = false;
    this.client.off('close', this.onClientClose);
    for (const connection of [...this.connections]) {
      this.cleanupConnection(connection, true);
    }
    this.closePromise = new Promise((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    await this.closePromise;
    this.emit('close');
  }
}
