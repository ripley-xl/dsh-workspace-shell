import { EventEmitter } from 'node:events';

export function wireKey(type = 'ssh-ed25519', payload = Buffer.alloc(32, 7)) {
  const typeBytes = Buffer.from(type);
  const typeLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(typeBytes.length);
  const payloadLength = Buffer.alloc(4);
  payloadLength.writeUInt32BE(payload.length);
  return Buffer.concat([typeLength, typeBytes, payloadLength, payload]);
}

export function knownHostsLine(host, key, type = 'ssh-ed25519', marker) {
  return `${marker ? `${marker} ` : ''}${host} ${type} ${key.toString('base64')}\n`;
}

export function baseConfig(overrides = {}) {
  return {
    alias: 'unit-test',
    hostname: 'unit.test.invalid',
    user: 'tester',
    port: 22,
    identityFiles: [],
    identityAgent: '/tmp/unit-test-agent.sock',
    hostKeyAlias: undefined,
    strictHostKeyChecking: 'yes',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    ...overrides,
  };
}

export class FakeClient extends EventEmitter {
  constructor(connect) {
    super();
    this.connectImplementation = connect;
    this.destroyed = false;
    this.ended = false;
  }

  connect(options) {
    this.options = options;
    this.connectImplementation?.(options, this);
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}
