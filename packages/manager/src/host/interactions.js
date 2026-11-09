import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { operationCancelled } from './ssh/errors.js';
import { appendKnownHostKey, verifyHostKey } from './ssh/known-hosts.js';

function publicPrompt(prompt) {
  return {
    prompt: String(prompt.prompt ?? '').slice(0, 2048),
    echo: prompt.echo === true,
  };
}

function publicRequest(hostId, kind, input, requestId) {
  return {
    requestId,
    hostId,
    kind,
    createdAt: new Date().toISOString(),
    ...input.name || input.instructions ? {
      name: String(input.name ?? '').slice(0, 256),
      instructions: String(input.instructions ?? '').slice(0, 2048),
    } : {},
    ...Array.isArray(input.prompts) ? { prompts: input.prompts.slice(0, 16).map(publicPrompt) } : {},
    ...input.fingerprint ? { fingerprint: String(input.fingerprint).slice(0, 256) } : {},
    ...input.host ? { host: String(input.host).slice(0, 256) } : {},
  };
}

function validateAnswer(kind, input) {
  if (kind === 'host-key') {
    if (typeof input.trusted !== 'boolean') throw new Error('trusted must be boolean.');
    return input.trusted;
  }
  if (kind === 'keyboardInteractive' || kind === 'keyboard-interactive') {
    if (!Array.isArray(input.responses) || input.responses.some((value) => typeof value !== 'string')) {
      throw new Error('responses must be a string array.');
    }
    return input.responses;
  }
  const value = input.value ?? input.response;
  if (typeof value !== 'string') throw new Error('A string response is required.');
  return value;
}

export class InteractionBroker extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
  }

  request(hostId, kind, input = {}) {
    const requestId = randomUUID();
    const publicValue = publicRequest(hostId, kind, input, requestId);
    return new Promise((resolve, reject) => {
      const pending = { hostId, kind, resolve, reject, public: publicValue };
      this.pending.set(requestId, pending);
      this.emit('interaction', publicValue);
      input.signal?.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          reject(operationCancelled(input.signal.reason));
          this.emit('interaction-ended', { requestId, hostId, reason: 'cancelled' });
        }
      }, { once: true });
    });
  }

  answer(requestId, input) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    const value = validateAnswer(pending.kind, input);
    this.pending.delete(requestId);
    pending.resolve(value);
    this.emit('interaction-ended', { requestId, hostId: pending.hostId, reason: 'answered' });
    return true;
  }

  cancel(requestId, reason = 'cancelled') {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.reject(operationCancelled());
    this.emit('interaction-ended', { requestId, hostId: pending.hostId, reason });
    return true;
  }

  cancelHost(hostId) {
    for (const [requestId, pending] of this.pending) {
      if (pending.hostId === hostId) this.cancel(requestId, 'host-closed');
    }
  }
}

export function authenticationCallbacks(broker, hostId) {
  return {
    password: (input) => broker.request(hostId, 'password', input),
    passphrase: (input) => broker.request(hostId, 'passphrase', input),
    keyboardInteractive: (input) => broker.request(hostId, 'keyboardInteractive', input),
  };
}

export function interactiveHostKeyVerifier(broker, hostId, dependencies = {}) {
  const verify = dependencies.verify ?? verifyHostKey;
  const append = dependencies.append ?? appendKnownHostKey;
  return async (key, options) => {
    try {
      return await verify(key, options);
    } catch (error) {
      if (error?.code !== 'SSH_HOST_KEY_UNKNOWN' || options.interactive !== true) throw error;
      const trusted = await broker.request(hostId, 'host-key', {
        ...error.details,
        signal: options.signal,
      });
      if (!trusted) throw error;
      const file = options.userKnownHostsFiles?.[0];
      if (!file) throw error;
      await append(file, {
        hostname: options.hostname,
        hostKeyAlias: options.hostKeyAlias,
        key,
        keyType: options.keyType,
        port: options.port,
      });
      return { status: 'accepted-new', ...error.details };
    }
  };
}
