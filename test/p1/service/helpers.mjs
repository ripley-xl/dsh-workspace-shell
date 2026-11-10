import { EventEmitter } from 'node:events';

import { ConnectionStore } from '../../../packages/manager/src/host/store.js';
import { SshRemoteService } from '../../../packages/manager/src/host/service.js';

export function memoryStorage() {
  const tables = new Map();
  return {
    async open(spec) {
      if (!tables.has('connections')) tables.set('connections', new Map());
      const records = tables.get('connections');
      const table = {
        get size() { return records.size; },
        get(key) { return records.get(key); },
        entries() { return records.entries(); },
        async put(key, value) { records.set(key, spec.tables.connections.valueSchema.parse(value)); },
        async delete(key) { return records.delete(key); },
        async update(key, mutate) {
          if (!records.has(key)) throw new Error('missing-key');
          const value = spec.tables.connections.valueSchema.parse(mutate(records.get(key)));
          records.set(key, value);
          return value;
        },
      };
      return { table: () => table, async close() {} };
    },
  };
}

export async function createStore() {
  return new ConnectionStore(memoryStorage()).open();
}

/**
 * A guest-transport channel: every remote call is scripted by the test through
 * `state.exec`, and `state.execs` records what the service asked for.
 */
export function guestChannel(state = {}) {
  const channel = new EventEmitter();
  channel.closed = false;
  channel.config = { alias: 'p0-test' };
  channel.execs = [];
  channel.exec = async (request) => {
    state.execs.push(request);
    return state.exec ? state.exec(request) : { code: 0, stdout: '', stderr: '' };
  };
  channel.upload = async (local, remote) => { (state.uploads ??= []).push({ local, remote }); };
  channel.close = async () => {
    channel.closed = true;
    channel.emit('close');
  };
  return channel;
}

/**
 * A manager service on the guest transport, with a scripted SSH channel.
 * `state.exec(request)` answers remote commands; `openGuestChannel` may be
 * overridden for connection tests.
 */
export async function serviceFixture({
  version = '1.0.0', localBundles = async () => [], exec = null,
  openGuestChannel = null, autoConnectOnStart = false, channel = null,
} = {}) {
  const store = await createStore();
  const state = { execs: [], uploads: [], connects: 0, instances: [] };
  state.exec = exec;
  const guest = channel ?? guestChannel(state);
  const service = new SshRemoteService({
    store,
    autoConnectOnStart,
    localVersion: async () => version,
    localBundles,
    localHome: () => process.env.DSH_HOME ?? null,
    localReturnUrl: 'http://127.0.0.1:54542',
    openGuestChannel: openGuestChannel ?? (async () => {
      state.connects += 1;
      return { channel: guest, controller: null, installed: null, artifact: null, target: null, transportMode: 'guest' };
    }),
  });
  return {
    service,
    store,
    state,
    channel: guest,
    async close() { await service.close(); await store.close(); },
  };
}

export async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the condition.');
}

export async function waitForPhase(service, hostId, phase, timeoutMs = 2_000) {
  return waitFor(() => service.publicConnection(hostId)?.phase === phase, timeoutMs);
}
