import { EventEmitter } from 'node:events';
import net from 'node:net';

import { ConnectionStore } from '../../../packages/manager/src/host/store.js';
import { SshRemoteService } from '../../../packages/manager/src/host/service.js';
import { SshControlChannel } from '../../../packages/manager/src/host/ssh/control-channel.js';

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

function artifact(version, controllerVersion = null) {
  const runtimeId = `${version}${controllerVersion ? `-controller-${controllerVersion}` : ''}-linux-x64-glibc`;
  return {
    artifactPath: `/artifacts/dsh-${runtimeId}.tar.gz`,
    filename: `dsh-${runtimeId}.tar.gz`,
    runtimeId,
    dshVersion: version,
    version,
    buildId: 'build-1',
    sha256: 'a'.repeat(64),
    size: 1,
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    ...controllerVersion ? { controllerVersion } : {},
  };
}

/** The registry package name a spec installs; used to key per-plugin fixtures. */
function packageName(spec) {
  if (typeof spec !== 'string') return '';
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    const at = slash < 0 ? -1 : spec.indexOf('@', slash);
    return at > 0 ? spec.slice(0, at) : spec;
  }
  const at = spec.indexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function remoteState() {
  return {
    sequence: 0,
    instances: [],
    hosts: [],
    calls: [],
    stops: [],
    releases: [],
    restartNext: false,
    failSettingsUpdate: false,
    profiles: undefined,
    profileCalls: 0,
    profilesError: null,
    remotePlugins: [],
    pluginRemovals: [],
    pluginInstalls: [],
    pluginInstallResults: null,
    failPluginInstall: null,
    failPluginRemove: null,
    backupCalls: 0,
  };
}

function channelFor(state) {
  // A real SshControlChannel over an in-memory ssh2-like client keeps the
  // shared-channel and port-forward behaviour under test.
  const client = new EventEmitter();
  client.end = () => {};
  client.destroy = () => {};
  client.forwardOut = (_sourceHost, _sourcePort, _targetHost, targetPort, callback) => {
    const remote = net.connect({ host: '127.0.0.1', port: targetPort });
    remote.once('connect', () => callback(null, remote));
    remote.once('error', () => callback(new Error('remote port refused')));
  };
  const channel = new SshControlChannel(client, { alias: 'p0-test' });
  const close = channel.close.bind(channel);
  channel.close = async () => {
    await close();
    if (!channel.closed) {
      channel.closed = true;
      channel.emit('close');
    }
  };
  return channel;
}

function controllerFor(state, channel, runtimeId = null) {
  return {
    async profiles() {
      state.profileCalls += 1;
      if (state.profilesError) throw state.profilesError;
      return { profiles: state.profiles ?? [{ id: 'web', web: true }] };
    },
    async list(input = {}) {
      return {
        instances: state.instances.filter((entry) => (input.version === undefined || entry.instance.dshVersion === input.version)
          && (input.buildId === undefined || entry.instance.buildId === input.buildId)
          && (input.profileId === undefined || (entry.instance.profileId ?? 'web') === input.profileId)),
      };
    },
    async start({ version, buildId, workspace, profileId = 'web' }) {
      state.sequence += 1;
      const instance = {
        instanceId: `instance-${state.sequence}`,
        dshVersion: version,
        buildId,
        createdBy: runtimeId,
        workspace,
        profileId,
        endpoint: { host: '127.0.0.1', port: 41000 + state.sequence },
      };
      state.instances.push({ instance, health: { healthy: true }, active: true, clientCount: 0 });
      return { instance };
    },
    async attach({ instanceId, clientLeaseId }) {
      const entry = state.instances.find((candidate) => candidate.instance.instanceId === instanceId && candidate.health.healthy);
      if (!entry) throw new Error('instance unavailable');
      return {
        instance: entry.instance,
        authenticatedUrl: `http://127.0.0.1:${entry.instance.endpoint.port}/?tkn=secret-${instanceId}`,
        clientLeaseId: clientLeaseId ?? `lease-${instanceId}-${state.releases.length}-${state.calls.length}`,
      };
    },
    async release(input) { state.releases.push(input); return { released: true }; },
    async heartbeat(input) { return { ...input, health: { healthy: true } }; },
    async stop({ instanceId }) {
      state.stops.push(instanceId);
      const entry = state.instances.find((candidate) => candidate.instance.instanceId === instanceId);
      if (entry) {
        entry.health.healthy = false;
        entry.active = false;
      }
      return { instanceId, stopped: true };
    },
  };
}

export class FakeRemoteHost extends EventEmitter {
  constructor(options) {
    super();
    Object.assign(this, options);
    this.closed = false;
    this.instanceId = null;
    this.client = null;
    this.browserUrl = null;
    this.profileId = options.profileId ?? 'web';
    this.startMode = options.startMode ?? 'auto';
    this.onChannelClose = () => {
      this.closed = true;
      this.client = null;
      this.emit('close');
    };
    this.channel.once('close', this.onChannelClose);
  }

  async open() {
    if (this.state?.openDelay) await this.state.openDelay(this.profileId);
    const listed = await this.controller.list({ version: this.version, buildId: this.buildId, profileId: this.profileId });
    let instance = listed.instances.find((entry) => entry.health.healthy
      && (entry.instance.profileId ?? 'web') === this.profileId)?.instance;
    if (!instance && this.startMode === 'reuse-only') {
      const error = new Error('no healthy remote instance exists for this profile');
      error.code = 'REMOTE_INSTANCE_UNAVAILABLE';
      throw error;
    }
    if (!instance) instance = (await this.controller.start({
      version: this.version,
      buildId: this.buildId,
      workspace: this.workspace,
      patch: this.patch,
      profileId: this.profileId,
    })).instance;
    const attached = await this.controller.attach({
      instanceId: instance.instanceId, version: this.version, buildId: this.buildId, profileId: this.profileId,
    });
    this.instanceId = instance.instanceId;
    this.clientLeaseId = attached.clientLeaseId;
    this.browserUrl = `http://localhost:52000/?tkn=secret-${instance.instanceId}`;
    const state = this.state;
    const host = this;
    this.client = {
      instanceId: instance.instanceId,
      async post(path, body) {
        state.calls.push({ path, body, instanceId: host.instanceId });
        if (path === '/api/ssh-remote/settings/update' && state.failSettingsUpdate) {
          throw Object.assign(new Error('simulated settings write failure'), { code: 'CONFIG_SYNC_PARTIAL' });
        }
        if (path === '/api/ssh-remote/plugins/list') {
          return { ok: true, bundles: state.remotePlugins ?? [] };
        }
        if (path === '/api/ssh-remote/sync/backup') {
          state.backupCalls += 1;
          return {
            ok: true,
            backup: {
              id: `backup-${state.backupCalls}`,
              path: `/remote/backups/${state.backupCalls}`,
              createdAt: '2026-01-01T00:00:00Z',
              profile: body?.profile ?? 'web',
            },
          };
        }
        if (path === '/api/ssh-remote/plugins/remove') {
          state.pluginRemovals.push(body?.name);
          if (state.failPluginRemove === body?.name) {
            throw Object.assign(new Error('simulated remove failure'), { code: 'REMOTE_OPERATION_FAILED' });
          }
          return { ok: true, result: { application: 'applied', changed: true } };
        }
        if (path === '/api/ssh-remote/plugins/install') {
          const name = packageName(body?.spec ?? '');
          state.pluginInstalls.push({ spec: body?.spec, requestId: body?.requestId, name });
          const custom = state.pluginInstallResults?.[name];
          if (custom) return { ok: custom.ok !== false, result: custom };
          if (state.failPluginInstall === true || state.failPluginInstall === name) {
            throw Object.assign(new Error('simulated install failure'), { code: 'REMOTE_OPERATION_FAILED' });
          }
          if (state.restartNext) {
            state.restartNext = false;
            return { ok: true, result: { application: 'restart-required', pendingBuilds: [] } };
          }
          return { ok: true, result: { application: 'applied', pendingBuilds: [] } };
        }
        return { ok: true };
      },
    };
    return this;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.channel.off('close', this.onChannelClose);
    if (!this.channel.closed && this.instanceId) await this.controller.release({ instanceId: this.instanceId, clientLeaseId: this.clientLeaseId });
    this.client = null;
    this.browserUrl = null;
  }
}

export async function serviceFixture({
  version = '1.0.0', controllerVersion = null, remotePlugins = [], shareLocalPlugins,
  uploadLocalPluginSnapshot, localBundles, autoConnectOnStart = false,
} = {}) {
  const store = await createStore();
  const state = remoteState();
  state.remotePlugins = remotePlugins;
  let localVersion = version;
  let currentControllerVersion = controllerVersion;
  const currentArtifact = (requestedVersion) => artifact(requestedVersion ?? localVersion, currentControllerVersion);
  const credentialCalls = [];
  const descriptors = [
    { ns: 'ui-theme', value: { preference: 'dark', fontSize: 14 } },
    { ns: 'model', value: { enabled: true, apiKey: 'do-not-copy' }, schema: { properties: { apiKey: { credentialRef: 'TEST_KEY' } } }, secrets: [{ path: ['apiKey'], set: true }] },
  ];
  const openControllerSession = async ({ alias, version: requestedVersion, channel: sharedChannel }) => {
    // Mirrors the real helper: a supplied channel is reused, not replaced.
    const channel = sharedChannel ?? channelFor(state);
    channel.config.alias = alias;
    const selected = currentArtifact(requestedVersion);
    return {
      channel,
      controller: controllerFor(state, channel, selected.runtimeId),
      installed: { home: '/home/test', root: '/home/test/.dsh/ssh-remote', runtime: { ...selected, ...selected.target } },
      artifact: selected,
      target: selected.target,
    };
  };
  const service = new SshRemoteService({
    store,
    autoConnectOnStart,
    catalog: { select: async ({ version: requestedVersion }) => currentArtifact(requestedVersion) },
    localVersion: () => localVersion,
    localReturnUrl: 'http://127.0.0.1:54542/?tkn=local-secret',
    settings: { describe: () => descriptors },
    credentials: {
      async resolve(ref) {
        credentialCalls.push(ref);
        return { value: `secret-value-${ref}`, source: 'test' };
      },
    },
    openControllerSession,
    ...localBundles ? { localBundles } : {},
    ...shareLocalPlugins ? { shareLocalPlugins } : {},
    ...uploadLocalPluginSnapshot ? { uploadLocalPluginSnapshot } : {},
    openRemoteHost: async (options) => {
      // Mirrors the real helper: a supplied channel is shared, not replaced.
      const channel = options.channel ?? channelFor(state);
      channel.config.alias = options.alias;
      const controller = controllerFor(state, channel, options.runtimeId ?? null);
      const host = new FakeRemoteHost({
        channel,
        controller,
        version: options.version,
        buildId: options.buildId,
        workspace: options.workspace ?? '/home/test',
        profileId: options.profileId,
        state,
      });
      await host.open();
      state.hosts.push(host);
      return {
        host,
        channel,
        controller,
        owned: options.channel === undefined,
        installed: { home: '/home/test', runtime: { ...currentArtifact(options.version), ...currentArtifact(options.version).target } },
      };
    },
    RemoteHostConnection: class extends FakeRemoteHost {
      constructor(options) { super({ ...options, state }); state.hosts.push(this); }
    },
    reconnectDelay: () => 1,
    maxReconnectAttempts: 2,
  });
  return {
    service,
    store,
    state,
    credentialCalls,
    descriptors,
    setVersion(value) { localVersion = value; },
    setControllerVersion(value) { currentControllerVersion = value; },
    runtimeIdFor(value = localVersion, controller = currentControllerVersion) { return artifact(value, controller).runtimeId; },
    async close() { await service.close(); await store.close(); },
  };
}

export async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the expected state.');
}

export function waitForPhase(service, hostId, phase, timeoutMs = 2_000) {
  if (service.publicConnection(hostId).phase === phase) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('connection', listener);
      reject(new Error(`Timed out waiting for ${phase}; current state is ${service.publicConnection(hostId).phase}.`));
    }, timeoutMs);
    const listener = (connection) => {
      if (connection.id !== hostId || connection.phase !== phase) return;
      clearTimeout(timer);
      service.off('connection', listener);
      resolve();
    };
    service.on('connection', listener);
  });
}
