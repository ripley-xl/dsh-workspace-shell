import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { publicError } from './diagnostics.js';
import { SshRemoteError } from './ssh/errors.js';
import { LoopbackGateway } from './ssh/gateway.js';

const LOOPBACK_HOST = '127.0.0.1';

function tunnelError(message, cause) {
  return new SshRemoteError('TUNNEL_FAILED', message, { cause });
}

function validateLocalPort(value) {
  const port = value ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('The local port must be an integer from 0 to 65535.');
  }
  return port;
}

function validateRemotePort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError('The remote port must be an integer from 1 to 65535.');
  }
  return value;
}

function validateLoopback(value, label) {
  const host = value ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new TypeError(`${label} must be ${LOOPBACK_HOST}.`);
  }
  return host;
}

function validateName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new TypeError('The port forward name must be a non-empty string of at most 128 characters.');
  }
  return value.trim();
}

function snapshot(record) {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    localHost: record.localHost,
    localPort: record.localPort,
    remoteHost: record.remoteHost,
    remotePort: record.remotePort,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error ? { ...record.error } : null,
  };
}

class ManagedLoopbackGateway extends LoopbackGateway {
  constructor(client, options) {
    super(client, options);
    client.off('close', this.onClientClose);
    this.localPort = options.localPort;
  }

  async listen() {
    if (this.closed) throw tunnelError('The port forward is closed.');
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
        reject(tunnelError('The local port forward could not start.', error));
      };
      const cleanup = () => {
        this.server.off('listening', onListening);
        this.server.off('error', onError);
      };
      this.server.once('listening', onListening);
      this.server.once('error', onError);
      try {
        this.server.listen({ host: LOOPBACK_HOST, port: this.localPort });
      } catch (error) {
        onError(error);
      }
    });
    return this.listenPromise;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listening = false;
    this.client.off('close', this.onClientClose);
    for (const connection of [...this.connections]) {
      this.cleanupConnection(connection, true);
    }
    this.closePromise = (async () => {
      if (this.listenPromise) await this.listenPromise.catch(() => {});
      if (this.server.listening) {
        await new Promise((resolve) => this.server.close(() => resolve()));
      }
      this.emit('close');
    })();
    return this.closePromise;
  }
}

export class PortForwardManager extends EventEmitter {
  constructor(channel, options = {}) {
    super();
    if (!channel?.client || typeof channel.assertOpen !== 'function') {
      throw new TypeError('An open SshControlChannel is required.');
    }
    this.channel = channel;
    this.records = new Map();
    this.closed = channel.closed === true;
    this.closePromise = undefined;
    this.idFactory = options.idFactory ?? randomUUID;
    this.gatewayFactory = options.gatewayFactory ?? ((gatewayOptions) => {
      const gateway = new ManagedLoopbackGateway(channel.client, gatewayOptions);
      if (channel.gateways instanceof Set) {
        channel.gateways.add(gateway);
        gateway.once('close', () => channel.gateways.delete(gateway));
      }
      return gateway;
    });
    this.onChannelClose = () => {
      this.closed = true;
      void this.closeAll().catch((error) => {
        this.emit('forwardError', { id: null, error: publicError(error) });
      });
    };
    if (!this.closed) channel.once('close', this.onChannelClose);
  }

  assertOpen() {
    if (this.closed || this.channel.closed) {
      throw tunnelError('The port forward manager is closed.');
    }
    this.channel.assertOpen();
  }

  change(record) {
    record.updatedAt = new Date().toISOString();
    this.emit('change', snapshot(record));
  }

  newId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.idFactory();
      if (typeof id === 'string' && id && !this.records.has(id)) return id;
    }
    throw tunnelError('A unique port forward ID could not be allocated.');
  }

  async add(options = {}) {
    this.assertOpen();
    const localHost = validateLoopback(options.localHost, 'The local host');
    const remoteHost = validateLoopback(options.remoteHost ?? options.targetHost, 'The remote host');
    const localPort = validateLocalPort(options.localPort);
    const remotePort = validateRemotePort(options.remotePort);
    const now = new Date().toISOString();
    const record = {
      id: this.newId(),
      name: validateName(options.name),
      state: 'opening',
      localHost,
      localPort,
      remoteHost,
      remotePort,
      createdAt: now,
      updatedAt: now,
      error: null,
      gateway: null,
      removePromise: null,
    };
    this.records.set(record.id, record);
    this.emit('change', snapshot(record));

    try {
      const gateway = this.gatewayFactory({
        localHost,
        localPort,
        remoteHost,
        remotePort,
        channelTimeoutMs: options.channelTimeoutMs,
      });
      if (!gateway || typeof gateway.listen !== 'function' || typeof gateway.close !== 'function') {
        throw new TypeError('The gateway factory must return a LoopbackGateway.');
      }
      record.gateway = gateway;
      gateway.on('gatewayError', (error) => {
        if (!['opening', 'active'].includes(record.state)) return;
        record.error = publicError(error);
        this.change(record);
        this.emit('forwardError', { id: record.id, error: record.error });
      });
      gateway.once('close', () => {
        if (['closing', 'closed', 'failed'].includes(record.state)) return;
        record.state = 'closed';
        this.change(record);
      });
      const address = await gateway.listen();
      if (this.closed || record.state !== 'opening') {
        throw tunnelError('The port forward closed before it became active.');
      }
      if (!address || address.host !== LOOPBACK_HOST || !Number.isSafeInteger(address.port) || address.port < 1) {
        throw tunnelError('The local port forward returned an invalid loopback address.');
      }
      record.localPort = address.port;
      record.state = 'active';
      this.change(record);
      return snapshot(record);
    } catch (cause) {
      const error = cause instanceof SshRemoteError
        ? cause
        : tunnelError('The port forward could not be opened.', cause);
      const closing = ['closing', 'closed'].includes(record.state);
      if (!closing) {
        record.state = 'failed';
        record.error = publicError(error);
        this.change(record);
      }
      if (record.gateway) await record.gateway.close().catch(() => {});
      if (!closing) this.emit('forwardError', { id: record.id, error: record.error });
      throw error;
    }
  }

  list() {
    return [...this.records.values()].map(snapshot);
  }

  async closeRecord(record) {
    if (record.removePromise) return record.removePromise;
    if (record.state === 'closed') return snapshot(record);
    record.state = 'closing';
    this.change(record);
    record.removePromise = (async () => {
      try {
        await record.gateway?.close();
        record.state = 'closed';
        record.error = null;
        this.change(record);
        return snapshot(record);
      } catch (cause) {
        const error = cause instanceof SshRemoteError
          ? cause
          : tunnelError('The port forward could not be closed.', cause);
        record.state = 'failed';
        record.error = publicError(error);
        this.change(record);
        this.emit('forwardError', { id: record.id, error: record.error });
        throw error;
      }
    })();
    return record.removePromise;
  }

  async remove(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const result = await this.closeRecord(record);
    if (record.state === 'closed') this.records.delete(id);
    return result;
  }

  async closeAll() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.channel.off('close', this.onChannelClose);
    const records = [...this.records.values()];
    this.closePromise = (async () => {
      const results = await Promise.allSettled(records.map((record) => this.closeRecord(record)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) {
        throw new AggregateError(failures.map((result) => result.reason), 'Some port forwards could not be closed.');
      }
      return results.map((result) => result.value);
    })();
    return this.closePromise;
  }
}
