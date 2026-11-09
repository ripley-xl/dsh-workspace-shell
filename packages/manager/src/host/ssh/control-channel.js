import { EventEmitter } from 'node:events';

import { execJson, execRemote } from './exec.js';
import { LoopbackGateway } from './gateway.js';
import { uploadFile } from './sftp.js';
import { SshRemoteError } from './errors.js';

export class SshControlChannel extends EventEmitter {
  constructor(client, config, options = {}) {
    super();
    this.client = client;
    this.config = config;
    this.resources = options.resources ?? [];
    this.closed = false;
    this.gateways = new Set();
    this.onClientClose = () => {
      this.closed = true;
      for (const gateway of [...this.gateways]) void gateway.close();
      for (const resource of this.resources) void Promise.resolve(resource.close()).catch(() => {});
      this.emit('close');
    };
    this.onClientError = (error) => {
      if (!this.closed) this.emit('transportError', error);
    };
    client.once('close', this.onClientClose);
    client.on('error', this.onClientError);
  }

  assertOpen() {
    if (this.closed) {
      throw new SshRemoteError('SSH_CONNECTION_FAILED', 'The SSH control channel is closed.');
    }
  }

  async exec(request, options) {
    this.assertOpen();
    return execRemote(this.client, request, options);
  }

  async execJson(request, options) {
    this.assertOpen();
    return execJson(this.client, request, options);
  }

  async upload(localPath, remotePath, options) {
    this.assertOpen();
    return uploadFile(this.client, localPath, remotePath, options);
  }

  createLoopbackGateway(options) {
    this.assertOpen();
    const gateway = new LoopbackGateway(this.client, options);
    this.gateways.add(gateway);
    gateway.once('close', () => this.gateways.delete(gateway));
    return gateway;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.client.off('close', this.onClientClose);
    for (const gateway of [...this.gateways]) await gateway.close();
    this.gateways.clear();
    try {
      this.client.end();
    } finally {
      this.client.destroy();
    }
    await Promise.allSettled(this.resources.map((resource) => resource.close()));
    this.resources = [];
    this.emit('close');
  }
}
