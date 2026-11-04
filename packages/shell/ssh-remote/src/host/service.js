import { EventEmitter } from 'node:events';

import { openRemoteHost } from './open-remote-host.js';
import { openControllerSession } from './controller-session.js';
import { RemoteHostConnection } from './remote-host.js';
import { syncRemote } from './remote-sync.js';
import { buildSyncInput, buildSyncPreview, discoverCredentialRefs } from './sync-input.js';
import { publicError } from './diagnostics.js';
import { addPortForward, createRemoteDiagnosticReport, listPortForwards, removePortForward } from './service-extensions.js';
import { authenticationCallbacks, InteractionBroker, interactiveHostKeyVerifier } from './interactions.js';
import { DEFAULT_PROFILE_ID, defaultProfiles, matchesProfile, normalizeInstanceList, normalizeProfileId, normalizeProfiles } from './profiles.js';
import { SharedStart } from './shared-start.js';
import { SshRemoteError, operationCancelled, operationTimeout } from './ssh/errors.js';

const ACTIVE_PHASES = new Set(['installing', 'upgrading', 'syncing', 'ready', 'switching', 'connected', 'reconnecting']);
const PHASE_PRIORITY = ['failed', 'reconnecting', 'upgrading', 'installing', 'syncing', 'switching', 'starting', 'ready', 'connected', 'idle'];
const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;
const DEFAULT_SYNC_TIMEOUT_MS = 180_000;
const DEFAULT_STOP_TIMEOUT_MS = 150_000;
const MAX_PROFILE_HOSTS = 16;

function error(code, message, details) {
  return new SshRemoteError(code, message, { details });
}

function cleanLocalReturnUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('localReturnUrl must be an HTTP(S) loopback URL.');
  }
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.origin;
}

function activeControllerChannel(host, runtime) {
  return host?.channel ?? runtime.channel;
}

function isHealthy(entry) {
  return Boolean(entry?.health?.healthy && entry?.active !== false);
}

function sharingNeedsRestart(report) {
  const entries = [
    report,
    report?.official,
    report?.official?.result,
    report?.result,
    ...Array.isArray(report?.official?.items) ? report.official.items : [],
    ...Array.isArray(report?.items) ? report.items : [],
  ];
  return entries.some((entry) => entry?.restartRequired === true || entry?.application === 'restart-required');
}

function sharingSucceeded(report) {
  return report?.ok !== false && report?.official?.ok !== false && report?.localInventory?.ok !== false;
}

function mergeAssessment(preview) {
  const settings = (preview?.conflicts?.length ?? 0) > 0;
  const plugins = preview?.operations?.some((operation) => (operation.type === 'official-plugin'
    && operation.remotePresent && operation.wouldChange)
    || (operation.type === 'plugin' && operation.currentVersion && operation.wouldChange));
  return {
    requiresMerge: Boolean(settings || plugins),
    mergeReasons: [...settings ? ['remote-user-settings'] : [], ...plugins ? ['remote-plugin-state'] : []],
  };
}

function backupMetadata(value) {
  if (!value || typeof value.id !== 'string' || typeof value.path !== 'string' || typeof value.createdAt !== 'string') {
    throw error('REMOTE_BACKUP_FAILED', 'The remote backup response is missing its id, path, or creation time.');
  }
  return {
    id: value.id,
    path: value.path,
    createdAt: value.createdAt,
    profile: value.profile === 'web' ? 'web' : value.profile,
    ...Number.isSafeInteger(value.bytes) ? { bytes: value.bytes } : {},
  };
}

function browserResult(service, runtime, sync) {
  return {
    ok: true,
    host: service.publicConnection(runtime.hostId),
    browserUrl: runtime.host.browserUrl,
    ...sync ? { sync } : {},
  };
}

async function bounded(callback, { timeoutMs, onController }) {
  const controller = new AbortController();
  onController?.(controller);
  const timer = setTimeout(() => controller.abort(operationTimeout('The SSH Remote operation timed out.')), timeoutMs);
  timer.unref?.();
  try {
    const operation = callback(controller.signal);
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        const abort = () => reject(controller.signal.reason ?? operationCancelled(controller.signal));
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener('abort', abort, { once: true });
        operation.finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => {});
      }),
    ]);
  } catch (value) {
    if (controller.signal.aborted && value?.code !== 'OPERATION_TIMEOUT') {
      throw controller.signal.reason ?? operationCancelled(controller.signal);
    }
    throw value;
  } finally {
    clearTimeout(timer);
    onController?.(null);
  }
}

/**
 * One SSH transport for a saved host. Every Web profile opened on that host
 * shares this channel, controller and port-forward set; only the lease,
 * gateway and RemoteHostConnection are per profile instance.
 */
export class HostSession extends EventEmitter {
  constructor(options) {
    super();
    this.hostId = options.hostId;
    this.alias = options.alias;
    this.channel = null;
    this.controller = null;
    this.installed = null;
    this.artifact = null;
    this.target = null;
    this.profiles = null;
    this.profilesError = null;
    this.operation = null;
    this.abort = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.starting = false;
    this.closing = false;
    this.closed = false;
    this.onChannelClose = () => this.handleChannelClose();
  }

  get connected() {
    return Boolean(this.channel && !this.channel.closed && this.controller);
  }

  get busy() {
    return Boolean(this.operation || this.starting);
  }

  attachTransport(session) {
    const previous = this.channel;
    this.channel = session.channel;
    this.controller = session.controller;
    this.installed = session.installed;
    this.artifact = session.artifact;
    this.target = session.target;
    this.channel.once('close', this.onChannelClose);
    if (previous && previous !== this.channel && !previous.closed) void previous.close().catch(() => {});
  }

  handleChannelClose() {
    const wasConnected = Boolean(this.controller);
    this.channel = null;
    this.controller = null;
    this.emit('channelClose', wasConnected);
  }

  clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async closeTransport() {
    const channel = this.channel;
    this.channel = null;
    this.controller = null;
    if (channel) {
      channel.off('close', this.onChannelClose);
      if (!channel.closed) await channel.close().catch(() => {});
    }
  }
}

export class SshRemoteService extends EventEmitter {
  constructor(options) {
    super();
    this.store = options.store;
    this.catalog = options.catalog;
    this.localVersion = options.localVersion;
    this.localReturnUrl = cleanLocalReturnUrl(options.localReturnUrl);
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.localBundles = options.localBundles ?? (async () => []);
    this.listConfiguredSshHosts = options.listConfiguredSshHosts ?? (async (input) => {
      const module = await import('./ssh/hosts.js');
      return module.listConfiguredSshHosts(input);
    });
    this.shareLocalPlugins = options.shareLocalPlugins ?? (async (client, bundles) => {
      const module = await import('./plugin-share.js');
      return module.shareLocalPlugins(client, bundles);
    });
    this.uploadLocalPluginSnapshot = options.uploadLocalPluginSnapshot ?? (async (client, snapshot) => {
      const module = await import('./plugin-share.js');
      return module.uploadLocalPluginSnapshot(client, snapshot);
    });
    this.createRemoteBackup = options.createRemoteBackup ?? (async (client, profileId = DEFAULT_PROFILE_ID) => {
      const response = await client.post('/api/ssh-remote/sync/backup', { profile: profileId });
      if (response?.ok === false || !response?.backup) throw error('REMOTE_BACKUP_FAILED', 'The remote Host could not create a synchronization backup.');
      return response.backup;
    });
    this.interactions = options.interactions ?? new InteractionBroker();
    this.openRemoteHost = options.openRemoteHost ?? openRemoteHost;
    this.openControllerSession = options.openControllerSession ?? openControllerSession;
    this.RemoteHostConnection = options.RemoteHostConnection ?? RemoteHostConnection;
    this.syncRemote = options.syncRemote ?? syncRemote;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.reconnectDelay = options.reconnectDelay ?? ((attempt) => Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.runtimes = new Map();
    this.sessions = new Map();
    this.profileRuntimesByHost = new Map();
    this.closingHosts = new WeakSet();
    this.autoConnectTimer = null;
    this.autoConnectStarted = false;
    this.autoConnectAttempts = new Set();
    this.closed = false;
    if (options.autoConnectOnStart !== false) this.autoConnectTimer = this.scheduleAutoConnectAll();
  }

  /** Background autoConnect for every saved record, never blocking service creation. */
  scheduleAutoConnectAll() {
    const timer = setTimeout(() => {
      this.autoConnectTimer = null;
      void this.autoConnectAll().catch(() => {});
    }, 0);
    timer.unref?.();
    return timer;
  }

  /**
   * A legacy `connect` opens a real Web Host for the default profile. Recording
   * it as that profile's Host keeps one instance per profile and lets the
   * profile APIs attach to it instead of starting a duplicate.
   */
  adoptDefaultWebHost(runtime, profileId) {
    if (profileId !== DEFAULT_PROFILE_ID || !runtime.host) return;
    const profileRuntime = this.profileRuntime(runtime.hostId, profileId);
    if (profileRuntime.host && profileRuntime.host !== runtime.host) return;
    profileRuntime.host = runtime.host;
    profileRuntime.instanceId = runtime.host.instanceId;
    profileRuntime.session = this.sessions.get(runtime.hostId) ?? null;
    profileRuntime.phase = 'running';
    profileRuntime.error = null;
    this.observeProfileHost(profileRuntime, runtime.host);
  }

  /** Default Web runtime for a saved host (legacy single-profile view). */
  runtime(hostId) {
    if (!this.runtimes.has(hostId)) {
      this.runtimes.set(hostId, {
        hostId,
        phase: 'idle',
        host: null,
        channel: null,
        controller: null,
        installed: null,
        artifact: null,
        operation: null,
        abort: null,
        reconnectTimer: null,
        reconnectAttempts: 0,
        error: null,
        sync: null,
        preview: null,
        portManager: null,
        portForwards: [],
      });
    }
    const runtime = this.runtimes.get(hostId);
    const session = this.sessions.get(hostId);
    if (session) {
      runtime.channel = session.channel;
      runtime.controller = session.controller;
      runtime.installed = session.installed;
      runtime.artifact = session.artifact;
    }
    return runtime;
  }

  /** All opened Web profiles of a host, keyed by instanceId. */
  profileRuntimes(hostId) {
    if (!this.profileRuntimesByHost.has(hostId)) this.profileRuntimesByHost.set(hostId, new Map());
    return this.profileRuntimesByHost.get(hostId);
  }

  session(hostId) {
    if (!this.sessions.has(hostId)) {
      const record = this.store.require(hostId);
      this.sessions.set(hostId, new HostSession({ hostId, alias: record.hostAlias }));
    }
    return this.sessions.get(hostId);
  }

  async profiles(hostId, { refresh = false } = {}) {
    this.store.require(hostId);
    const session = this.session(hostId);
    if (refresh && session.connected) await this.refreshProfiles(session);
    return {
      profiles: session.profiles?.length ? session.profiles : defaultProfiles(),
      profilesSource: session.profiles?.length ? 'remote' : 'default',
    };
  }

  /** Refreshes the cached profile list; failures keep the previous cache. */
  async refreshProfiles(session) {
    try {
      const raw = await session.controller.profiles({ dshHome: session.installed?.home });
      session.profiles = normalizeProfiles(raw);
    } catch (cause) {
      session.profilesError = publicError(cause);
    }
    return session.profiles ?? null;
  }

  profileHosts(hostId) {
    return [...this.profileRuntimes(hostId).values()]
      .filter((runtime) => runtime.instanceId || (runtime.host && !runtime.host.closed))
      .map((runtime) => this.publicProfileHost(runtime))
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  publicProfileHost(runtime) {
    const host = runtime.host && !runtime.host.closed ? runtime.host : null;
    const healthy = Boolean(host && runtime.phase === 'running');
    return {
      instanceId: host?.instanceId ?? runtime.instanceId ?? null,
      profileId: runtime.profileId,
      profileName: runtime.profileName ?? runtime.profileId,
      state: runtime.phase,
      phase: runtime.phase,
      health: {
        healthy,
        connected: Boolean(runtime.session?.connected),
        hostAlive: healthy,
        supervisorAlive: healthy,
      },
      error: publicError(runtime.error),
    };
  }

  profileRuntime(hostId, profileId, profileName) {
    const runtimes = this.profileRuntimes(hostId);
    if (!runtimes.has(profileId)) {
      runtimes.set(profileId, {
        hostId,
        profileId,
        profileName: profileName ?? profileId,
        phase: 'idle',
        host: null,
        instanceId: null,
        error: null,
        start: null,
        stopPromise: null,
        session: null,
      });
    }
    const runtime = runtimes.get(profileId);
    if (profileName) runtime.profileName = profileName;
    return runtime;
  }

  profileRuntimeByInstance(hostId, instanceId) {
    for (const runtime of this.profileRuntimes(hostId).values()) {
      const active = runtime.host && !runtime.host.closed ? runtime.host.instanceId : null;
      if (active === instanceId || runtime.instanceId === instanceId) return runtime;
    }
    return null;
  }

  async ensureProfileTransport(hostId, { background = false } = {}) {
    const session = this.session(hostId);
    await this.ensureTransport(session, {
      interactive: !background,
      background,
      timeoutMs: this.connectTimeoutMs,
    });
    return session;
  }

  /** Lists Web profiles and the hosts opened for them on this SSH host. */
  async webList(hostId) {
    const record = this.store.require(hostId);
    const session = this.session(hostId);
    if (session.connected) await this.refreshProfiles(session);
    return {
      ok: true,
      profiles: session.profiles?.length ? session.profiles : defaultProfiles(),
      profilesSource: session.profiles?.length ? 'remote' : 'default',
      connected: session.connected,
      hosts: this.profileHosts(hostId),
      hostAlias: record.hostAlias,
    };
  }

  /** Opens or reuses the single healthy Host of one Web profile. */
  webOpen(hostId, { profileId = DEFAULT_PROFILE_ID, profileName, signal, reuseOnly = false } = {}) {
    const id = normalizeProfileId(profileId);
    this.store.require(hostId);
    if (this.closed) return Promise.reject(error('SERVICE_DISPOSED', 'The SSH Remote service is disposed.'));
    const profiles = this.sessions.get(hostId)?.profiles;
    const known = profiles?.find((profile) => profile.id === id);
    if (profiles?.length && (!known || known.web !== true)) {
      return Promise.reject(error('PROFILE_NOT_WEB', 'The selected profile is not a Web profile.', { profileId: id }));
    }
    const runtime = this.profileRuntime(hostId, id, profileName ?? known?.name);
    if (runtime.phase === 'stopping') return Promise.reject(error('HOST_BUSY', 'The Web Host is stopping.'));
    if (runtime.start) return runtime.start.join(signal);
    if (runtime.host && !runtime.host.closed && runtime.phase === 'running') {
      return Promise.resolve(this.publicWebHost(runtime));
    }
    if (signal?.aborted) return Promise.reject(operationCancelled(signal));
    const start = new SharedStart((startSignal) => this.startProfileHost(runtime, startSignal, { reuseOnly }));
    runtime.start = start;
    start.promise.catch(() => {}).finally(() => {
      if (runtime.start === start) runtime.start = null;
    });
    return start.join(signal);
  }

  /** Returns the private Guest URL only for a Host this manager already holds. */
  async webAttach(hostId, { instanceId } = {}) {
    this.store.require(hostId);
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      throw error('INVALID_REQUEST', 'instanceId is required.');
    }
    const runtime = this.profileRuntimeByInstance(hostId, instanceId);
    if (runtime?.host && !runtime.host.closed && runtime.phase === 'running') {
      return this.publicWebHost(runtime);
    }
    const known = runtime?.profileId ?? null;
    const adoptable = known
      ? await this.verifyRemoteInstance(hostId, known, instanceId)
      : await this.findRemoteProfileForInstance(hostId, instanceId);
    if (!adoptable) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The remote instance is not available for this manager.');
    const opened = await this.webOpen(hostId, { profileId: adoptable.profileId, reuseOnly: true });
    if (opened.instanceId !== instanceId) {
      throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The remote instance is no longer the active host of its profile.', {
        profileId: adoptable.profileId,
        requestedInstanceId: instanceId,
      });
    }
    return opened;
  }

  /** Confirms one known instance is still healthy for its profile. */
  async verifyRemoteInstance(hostId, profileId, instanceId) {
    let session = this.sessions.get(hostId);
    if (!session?.connected) session = await this.ensureProfileTransport(hostId, { background: false });
    if (!session?.connected) return null;
    try {
      const listed = normalizeInstanceList(await session.controller.list({ profileId }));
      const match = listed.find((instance) => instance.instanceId === instanceId
        && instance.profileId === profileId
        && instance.health.healthy
        && instance.state !== 'stopped');
      return match ? { profileId, instanceId } : null;
    } catch {
      return null;
    }
  }

  /**
   * Finds the profile of a remote instance this manager does not hold yet.
   * The controller scopes every list to one profile, so each known profile is
   * queried; unknown instances stay unavailable rather than being guessed.
   */
  async findRemoteProfileForInstance(hostId, instanceId) {
    let session = this.sessions.get(hostId);
    if (!session?.connected) session = await this.ensureProfileTransport(hostId, { background: false });
    if (!session?.connected) return null;
    if (!session.profiles) await this.refreshProfiles(session);
    const candidates = session.profiles ?? defaultProfiles();
    for (const profile of candidates) {
      if (profile.web === false) continue;
      try {
        const listed = normalizeInstanceList(await session.controller.list({ profileId: profile.id }));
        const match = listed.find((instance) => instance.instanceId === instanceId
          && instance.profileId === profile.id
          && instance.health.healthy
          && instance.state !== 'stopped');
        if (match) return match;
      } catch {
        // A profile that cannot be listed is simply not adoptable here.
      }
    }
    return null;
  }

  publicWebHost(runtime) {
    const host = runtime.host;
    if (!host || host.closed) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The Web Host is not connected.');
    const url = host.browserUrl;
    if (typeof url !== 'string' || !url) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The Web Host did not expose a local URL.');
    return {
      ok: true,
      instanceId: host.instanceId,
      profileId: runtime.profileId,
      profileName: runtime.profileName,
      url,
      state: runtime.phase,
    };
  }

  async startProfileHost(runtime, signal, { reuseOnly = false } = {}) {
    const { hostId, profileId } = runtime;
    runtime.phase = 'starting';
    runtime.error = null;
    if (runtime.host && !runtime.host.closed) {
      this.closingHosts.add(runtime.host);
      await runtime.host.close().catch(() => {});
      runtime.host = null;
    }
    try {
      const session = await this.ensureProfileTransport(hostId, { background: false });
      runtime.session = session;
      signal.throwIfAborted();
      if (this.closed) throw operationCancelled(signal);
      const version = await this.localVersion();
      if (!version) throw error('REMOTE_VERSION_MISMATCH', 'The local DSH version is unavailable.');
      const artifact = session.artifact ?? await this.catalog.select({
        version,
        target: session.target,
        signal,
      });
      signal.throwIfAborted();
      const listed = normalizeInstanceList(await session.controller.list({ version: artifact.dshVersion, buildId: artifact.buildId, profileId }));
      const existing = listed.find((instance) => instance.profileId === profileId
        && instance.health.healthy
        && instance.state !== 'stopped');
      if (!existing && reuseOnly) {
        throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The recorded remote Host is no longer available for this profile.', {
          profileId,
          instanceId: runtime.instanceId ?? null,
        });
      }
      const host = new this.RemoteHostConnection({
        channel: session.channel,
        controller: session.controller,
        version: artifact.dshVersion,
        buildId: artifact.buildId,
        workspace: session.installed?.home,
        startMode: existing ? 'reuse-only' : 'auto',
        profileId,
      });
      await host.open();
      // The last waiter cancelled before the Host became ready: stop a process
      // this operation created, but never touch an instance it merely reused.
      if (signal.aborted || runtime.phase !== 'starting') {
        const instanceId = host.instanceId;
        await host.close().catch(() => {});
        if (!existing && instanceId) {
          await session.controller.stop({ instanceId }).catch(() => {});
        }
        throw operationCancelled(signal);
      }
      runtime.host = host;
      runtime.instanceId = host.instanceId;
      runtime.phase = 'running';
      this.observeProfileHost(runtime, host);
      this.publish(hostId);
      return this.publicWebHost(runtime);
    } catch (cause) {
      runtime.host = null;
      const cancelled = cause?.code === 'OPERATION_CANCELLED' || signal.aborted;
      runtime.phase = cancelled ? 'idle' : 'failed';
      runtime.error = cancelled ? null : publicError(cause);
      // A cancelled start that never produced a Host is not a Host at all.
      if (cancelled && !runtime.instanceId) this.profileRuntimes(hostId).delete(runtime.profileId);
      this.publish(hostId);
      throw cancelled ? operationCancelled(signal) : cause;
    }
  }

  observeProfileHost(runtime, host) {
    host.once('close', () => {
      if (this.closed || this.closingHosts.has(host) || runtime.host !== host) return;
      runtime.host = null;
      if (runtime.phase === 'running') runtime.phase = 'offline';
      runtime.error = runtime.error ?? null;
      this.publish(runtime.hostId);
    });
  }

  async releaseProfileRuntime(runtime, { keepRemote = true } = {}) {
    const host = runtime.host;
    runtime.host = null;
    runtime.start?.abort(operationCancelled());
    runtime.start = null;
    if (host) {
      this.closingHosts.add(host);
      await host.close().catch(() => {});
    }
    if (!keepRemote) runtime.instanceId = null;
    if (runtime.phase !== 'failed') runtime.phase = keepRemote ? 'offline' : 'idle';
  }

  /** Stops one profile Host; other profile Hosts of the same SSH connection stay up. */
  webStop(hostId, { instanceId } = {}) {
    this.store.require(hostId);
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return Promise.reject(error('INVALID_REQUEST', 'instanceId is required.'));
    }
    const runtime = this.profileRuntimeByInstance(hostId, instanceId);
    if (!runtime) {
      return Promise.reject(error('REMOTE_INSTANCE_UNAVAILABLE', 'The requested Web Host is not managed by this manager.', { instanceId }));
    }
    if (runtime.stopPromise) return runtime.stopPromise;
    if (runtime.phase === 'starting') return Promise.reject(error('HOST_BUSY', 'The Web Host is still starting.'));
    runtime.phase = 'stopping';
    this.publish(hostId);
    const promise = bounded(async (signal) => {
      const profileId = runtime.profileId;
      try {
        const host = runtime.host;
        if (host) {
          this.closingHosts.add(host);
          await host.close();
          runtime.host = null;
        }
        // Stopping must still work after a disconnect, so reconnect when needed.
        const session = await this.ensureProfileTransport(hostId, { background: false });
        signal.throwIfAborted();
        await session.controller.stop({ instanceId });
        signal.throwIfAborted();
        runtime.instanceId = null;
        runtime.phase = 'idle';
        runtime.error = null;
        this.profileRuntimes(hostId).delete(profileId);
        this.publish(hostId);
        return { ok: true, instanceId, profileId, host: this.publicConnection(hostId) };
      } catch (cause) {
        runtime.phase = 'failed';
        runtime.error = publicError(cause);
        this.publish(hostId);
        throw cause;
      }
    }, { timeoutMs: this.stopTimeoutMs }).finally(() => {
      if (runtime.stopPromise === promise) runtime.stopPromise = null;
    });
    runtime.stopPromise = promise;
    return promise;
  }

  async ensureTransport(session, options = {}) {
    if (session.connected) return session;
    if (session.operation) return session.operation;
    const record = this.store.require(session.hostId);
    const version = await this.localVersion();
    if (!version) throw error('REMOTE_VERSION_MISMATCH', 'The local DSH version is unavailable.');
    const interactive = options.interactive !== false && options.background !== true;
    const promise = bounded((signal) => this.openSessionTransport(session, record, {
      version,
      interactive,
      background: options.background === true,
      signal,
    }), {
      timeoutMs: options.timeoutMs ?? this.connectTimeoutMs,
      onController: (controller) => { session.abort = controller; },
    });
    session.operation = promise;
    try {
      return await promise;
    } finally {
      if (session.operation === promise) session.operation = null;
      session.abort = null;
    }
  }

  async openSessionTransport(session, record, { version, interactive, background, signal }) {
    const opened = await this.openControllerSession({
      alias: record.hostAlias,
      catalog: this.catalog,
      version,
      signal,
      interactive,
      background,
      authCallbacks: authenticationCallbacks(this.interactions, session.hostId),
      hostKeyVerifier: interactiveHostKeyVerifier(this.interactions, session.hostId),
    });
    signal.throwIfAborted();
    if (session.closed) {
      await opened.channel.close().catch(() => {});
      throw operationCancelled(signal);
    }
    session.attachTransport(opened);
    this.publish(session.hostId);
    return session;
  }

  publicConnection(hostId) {
    const record = this.store.require(hostId);
    const runtime = this.runtime(hostId);
    const session = this.sessions.get(hostId);
    const channel = session?.channel ?? runtime.channel;
    const config = channel && !channel.closed && channel.config?.alias === record.hostAlias ? channel.config : null;
    return {
      ...record,
      // Publish only display fields, never proxy commands or authentication material.
      hostName: config?.hostname ?? null,
      port: config?.port ?? null,
      user: config?.user ?? null,
      identityFiles: [...config?.identityFiles ?? []],
      phase: runtime.phase,
      instanceId: runtime.host?.instanceId ?? null,
      remoteVersion: runtime.host?.version ?? null,
      remoteBuildId: runtime.host?.buildId ?? null,
      connected: Boolean(session?.connected),
      error: publicError(runtime.error),
      sync: runtime.sync,
      reconnectAttempts: runtime.reconnectAttempts,
      portForwards: runtime.portManager?.list() ?? runtime.portForwards ?? [],
      profiles: this.profileHosts(hostId),
      autoConnect: record.autoConnect === true,
    };
  }

  publish(hostId) {
    if (!this.store.get(hostId)) return;
    this.emit('connection', this.publicConnection(hostId));
  }

  transition(runtime, phase, cause = null) {
    runtime.phase = phase;
    runtime.error = cause ? publicError(cause) : null;
    this.publish(runtime.hostId);
  }

  async status() {
    const connections = this.store.list().map((record) => this.publicConnection(record.id));
    const phase = PHASE_PRIORITY.find((candidate) => connections.some((connection) => connection.phase === candidate)) ?? 'idle';
    return {
      ok: true,
      role: 'manager',
      phase,
      dshVersion: await this.localVersion(),
      localReturnUrl: this.localReturnUrl,
      connections,
    };
  }

  async sshHosts({ query = '' } = {}) {
    const hosts = await this.listConfiguredSshHosts();
    const needle = String(query).trim().toLowerCase();
    return {
      ok: true,
      hosts: needle ? hosts.filter((host) => [host.alias, host.hostName, host.user]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) : hosts,
    };
  }

  async upsert(input) {
    const requestedId = input.id ?? input.hostId;
    const existing = requestedId ? this.store.get(requestedId) : input.hostAlias ? this.store.byAlias(input.hostAlias) : undefined;
    if (existing && ACTIVE_PHASES.has(this.runtime(existing.id).phase)
      && (input.hostAlias ?? existing.hostAlias) !== existing.hostAlias) {
      throw error('HOST_BUSY', 'Disconnect the SSH host before changing its alias.');
    }
    const record = await this.store.upsert(input);
    const runtime = this.runtime(record.id);
    runtime.preview = null;
    this.publish(record.id);
    if (record.autoConnect === true && !existing?.autoConnect) {
      this.autoConnectAttempts.delete(record.id);
      this.scheduleAutoConnect(record.id);
    } else if (record.autoConnect !== true && existing?.autoConnect === true) {
      this.autoConnectAttempts.delete(record.id);
      await this.disconnect(record.id);
    }
    return { ok: true, host: this.publicConnection(record.id) };
  }

  /**
   * Background initial connection for records saved with autoConnect=true.
   * Attempts are deduplicated per record so a slow startup cannot stack
   * repeated logins; toggling autoConnect back on makes the record eligible.
   */
  scheduleAutoConnect(hostId) {
    if (this.closed || !this.store.get(hostId)) return;
    if (this.autoConnectAttempts.has(hostId)) return;
    this.autoConnectAttempts.add(hostId);
    const timer = setTimeout(() => {
      if (this.closed || !this.store.get(hostId)) return;
      const record = this.store.get(hostId);
      if (record?.autoConnect !== true) return;
      const runtime = this.runtime(hostId);
      if (runtime.operation || runtime.host) return;
      this.connect(hostId, { background: true }).catch(() => {});
    }, 0);
    timer.unref?.();
  }

  async autoConnectAll() {
    if (this.closed) return { ok: true, attempted: 0 };
    this.autoConnectStarted = true;
    const records = this.store.list().filter((record) => record.autoConnect === true);
    for (const record of records) this.scheduleAutoConnect(record.id);
    return { ok: true, attempted: this.autoConnectAttempts.size };
  }

  async remove(hostId) {
    this.store.require(hostId);
    await this.disconnect(hostId);
    const removed = await this.store.remove(hostId);
    this.runtimes.delete(hostId);
    this.profileRuntimesByHost.delete(hostId);
    this.sessions.delete(hostId);
    this.autoConnectAttempts.delete(hostId);
    this.emit('removed', { hostId, removed });
    return { ok: true, removed };
  }

  clearReconnect(runtime) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }

  connect(hostId, { allowUpgrade = false, background = false, reconnectInstanceId, profileId = DEFAULT_PROFILE_ID } = {}) {
    const runtime = this.runtime(hostId);
    if (runtime.operation) return runtime.operation;
    this.clearReconnect(runtime);
    if (typeof allowUpgrade !== 'boolean') return Promise.reject(error('INVALID_REQUEST', 'allowUpgrade must be boolean.'));
    const promise = bounded((signal) => this.performConnect(runtime, {
      allowUpgrade,
      background,
      reconnectInstanceId,
      profileId: normalizeProfileId(profileId),
      signal,
    }), {
      timeoutMs: this.connectTimeoutMs,
      onController: (controller) => { runtime.abort = controller; },
    }).catch((cause) => {
      if (cause?.code === 'OPERATION_TIMEOUT' && runtime.phase !== 'failed') this.transition(runtime, 'failed', cause);
      throw cause;
    });
    runtime.operation = promise;
    return promise.finally(() => {
      if (runtime.operation === promise) runtime.operation = null;
    });
  }

  interactiveOptions(runtime, background, signal) {
    return {
      signal,
      interactive: !background,
      background,
      hostId: runtime.hostId,
      authCallbacks: authenticationCallbacks(this.interactions, runtime.hostId),
      hostKeyVerifier: interactiveHostKeyVerifier(this.interactions, runtime.hostId),
    };
  }

  async performConnect(runtime, options) {
    const { signal, background, allowUpgrade } = options;
    const profileId = normalizeProfileId(options.profileId);
    const record = this.store.require(runtime.hostId);
    const version = await this.localVersion();
    if (!version) throw error('REMOTE_VERSION_MISMATCH', 'The local DSH version is unavailable.');

    if (runtime.host && !runtime.host.closed && runtime.phase === 'connected') {
      if (runtime.host.version === version && runtime.host.buildId === runtime.artifact?.buildId
        && this.sessions.get(runtime.hostId)?.connected) {
        this.transition(runtime, 'switching');
        this.transition(runtime, 'connected');
        return browserResult(this, runtime);
      }
      if (!allowUpgrade) {
        throw error('UPGRADE_CONFIRMATION_REQUIRED', 'The active remote instance uses a different DSH build. Confirm the upgrade before stopping it.', {
          hostId: runtime.hostId,
          instanceId: runtime.host.instanceId,
          localVersion: version,
          remoteVersion: runtime.host.version,
        });
      }
      const old = runtime.host;
      this.closingHosts.add(old);
      try {
        await old.close();
        await old.controller.stop({ instanceId: old.instanceId });
        await old.channel.close();
        runtime.host = null;
        runtime.channel = null;
        runtime.controller = null;
      } catch (cause) {
        await this.releaseRuntime(runtime);
        this.transition(runtime, 'failed', cause);
        throw cause;
      }
    }

    const targetVersionChanged = Boolean(record.lastServerVersion && record.lastServerVersion !== version);
    this.transition(runtime, targetVersionChanged ? 'upgrading' : 'installing');
    let session;
    let opened;
    let selectedArtifact;
    try {
      const shared = this.session(runtime.hostId);
      const existingTransport = shared.connected ? shared : null;
      if (existingTransport) {
        session = {
          channel: existingTransport.channel,
          controller: existingTransport.controller,
          installed: existingTransport.installed,
          artifact: existingTransport.artifact,
          target: existingTransport.target,
        };
      } else {
        session = await this.openControllerSession({
          alias: record.hostAlias,
          catalog: this.catalog,
          version,
          signal,
          interactive: !background,
          background,
          authCallbacks: authenticationCallbacks(this.interactions, runtime.hostId),
          hostKeyVerifier: interactiveHostKeyVerifier(this.interactions, runtime.hostId),
        });
        shared.attachTransport(session);
        session = {
          channel: shared.channel,
          controller: shared.controller,
          installed: shared.installed,
          artifact: shared.artifact,
          target: shared.target,
        };
      }
      signal.throwIfAborted();
      selectedArtifact = session.artifact;
      const listed = await session.controller.list({ profileId });
      signal.throwIfAborted();
      const savedId = options.reconnectInstanceId ?? record.lastInstanceId;
      const candidates = listed.instances.filter((entry) => matchesProfile(entry, profileId));
      const previous = candidates.find((entry) => entry.instance?.instanceId === savedId);
      const exact = previous?.instance?.dshVersion === version && previous?.instance?.buildId === session.artifact.buildId;

      if (isHealthy(previous) && !exact && !allowUpgrade) {
        throw error('UPGRADE_CONFIRMATION_REQUIRED', 'The saved remote instance is active but uses a different DSH build. Confirm the upgrade before stopping it.', {
          hostId: runtime.hostId,
          instanceId: savedId,
          profileId,
          localVersion: version,
          remoteVersion: previous.instance.dshVersion,
        });
      }
      if (isHealthy(previous) && !exact && allowUpgrade) {
        this.transition(runtime, 'upgrading');
        await session.controller.stop({ instanceId: savedId });
      }

      if (exact && isHealthy(previous)) {
        const host = await this.attachExisting(runtime, session, previous.instance.instanceId, profileId);
        runtime.host = host;
        runtime.channel = session.channel;
        runtime.controller = session.controller;
        runtime.installed = session.installed;
        runtime.artifact = session.artifact;
        this.observeHost(runtime, host);
      } else {
        this.transition(runtime, targetVersionChanged ? 'upgrading' : 'installing');
        opened = await this.openRemoteHost({
          alias: record.hostAlias,
          channel: session.channel,
          version,
          buildId: selectedArtifact.buildId,
          runtimeId: selectedArtifact.runtimeId,
          localReturnUrl: this.localReturnUrl,
          profileId,
          ...this.interactiveOptions(runtime, background, signal),
        });
        opened.artifact = selectedArtifact;
      }

      if (opened) {
        runtime.host = opened.host;
        runtime.channel = opened.channel;
        runtime.controller = opened.controller;
        runtime.installed = opened.installed;
        runtime.artifact = opened.artifact;
        this.observeHost(runtime, opened.host);
      }
      if (runtime.host.version !== version || runtime.host.buildId !== runtime.artifact?.buildId) {
        throw error('REMOTE_VERSION_MISMATCH', 'The attached remote instance does not match the selected local build.');
      }
      signal.throwIfAborted();

      let sync;
      if (!background && !record.lastConnectedAt) {
        try {
          sync = await this.performSync(runtime, signal, { initial: true, profileId });
        } catch (cause) {
          if (!runtime.host) throw cause;
          sync = { ok: false, error: publicError(cause) };
          runtime.sync = sync;
        }
      }
      const connected = await this.store.markConnected(runtime.hostId, {
        instanceId: runtime.host.instanceId,
        version,
        buildId: runtime.artifact.buildId,
      });
      runtime.reconnectAttempts = 0;
      this.adoptDefaultWebHost(runtime, profileId);
      this.transition(runtime, 'ready');
      this.transition(runtime, 'switching');
      this.transition(runtime, 'connected');
      return { ...browserResult(this, runtime, sync), host: { ...this.publicConnection(runtime.hostId), ...connected, phase: 'connected' } };
    } catch (cause) {
      this.interactions.cancelHost(runtime.hostId);
      if (runtime.host) await this.releaseRuntime(runtime);
      const confirmation = cause?.code === 'UPGRADE_CONFIRMATION_REQUIRED';
      this.transition(runtime, confirmation ? 'idle' : 'failed', cause);
      throw cause;
    }
  }

  async attachExisting(runtime, session, instanceId, profileId = DEFAULT_PROFILE_ID) {
    const controller = session.controller;
    const adapter = {
      async list(input) {
        const listed = await controller.list(input);
        const selected = listed.instances.filter((entry) => entry.instance?.instanceId === instanceId && matchesProfile(entry, profileId));
        if (!selected.some(isHealthy)) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The original remote instance is no longer healthy.');
        return { ...listed, instances: selected };
      },
      attach: controller.attach.bind(controller),
      heartbeat: controller.heartbeat.bind(controller),
      release: controller.release.bind(controller),
      start: controller.start.bind(controller),
      stop: controller.stop.bind(controller),
    };
    const host = new this.RemoteHostConnection({
      channel: session.channel,
      controller: adapter,
      version: session.artifact.dshVersion,
      buildId: session.artifact.buildId,
      workspace: session.installed.home,
      profileId,
    });
    await host.open();
    if (host.instanceId !== instanceId) {
      await host.close();
      throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The remote host attached to an unexpected instance.');
    }
    return host;
  }

  observeHost(runtime, host) {
    host.once('close', () => {
      if (this.closed || this.closingHosts.has(host) || runtime.host !== host) return;
      runtime.host = null;
      runtime.channel = null;
      runtime.controller = null;
      if (runtime.phase === 'connected') this.scheduleReconnect(runtime, host.instanceId);
    });
    host.on('heartbeatError', (cause) => {
      if (runtime.host !== host || runtime.phase !== 'connected') return;
      runtime.error = publicError(cause);
      this.publish(runtime.hostId);
    });
  }

  scheduleReconnect(runtime, instanceId) {
    this.clearReconnect(runtime);
    runtime.reconnectAttempts = 0;
    this.transition(runtime, 'reconnecting');
    const attempt = () => {
      runtime.reconnectTimer = null;
      runtime.reconnectAttempts += 1;
      this.connect(runtime.hostId, { background: true, reconnectInstanceId: instanceId }).catch(async (cause) => {
        if (this.closed || !this.runtimes.has(runtime.hostId)) return;
        if (cause?.code === 'UPGRADE_CONFIRMATION_REQUIRED' || runtime.reconnectAttempts >= this.maxReconnectAttempts) {
          this.transition(runtime, 'failed', cause);
          return;
        }
        this.transition(runtime, 'reconnecting', cause);
        runtime.reconnectTimer = setTimeout(attempt, this.reconnectDelay(runtime.reconnectAttempts));
        runtime.reconnectTimer.unref?.();
      });
    };
    runtime.reconnectTimer = setTimeout(attempt, this.reconnectDelay(1));
    runtime.reconnectTimer.unref?.();
  }

  async releaseRuntime(runtime) {
    const host = runtime.host;
    if (host) {
      this.closingHosts.add(host);
      await host.close().catch(() => {});
    }
    if (runtime.channel && !runtime.channel.closed) await runtime.channel.close().catch(() => {});
    runtime.host = null;
    runtime.channel = null;
    runtime.controller = null;
  }

  async disconnect(hostId) {
    const runtime = this.runtime(hostId);
    this.store.require(hostId);
    this.clearReconnect(runtime);
    this.interactions.cancelHost(hostId);
    runtime.abort?.abort(operationCancelled());
    const session = this.sessions.get(hostId);
    if (session) {
      session.clearReconnect();
      session.abort?.abort(operationCancelled());
    }
    for (const profileRuntime of this.profileRuntimes(hostId).values()) {
      await this.releaseProfileRuntime(profileRuntime, { keepRemote: true });
    }
    if (session) await this.closeSession(session);
    await this.releaseRuntime(runtime);
    runtime.reconnectAttempts = 0;
    runtime.sync = null;
    runtime.preview = null;
    this.transition(runtime, 'idle');
    return { ok: true, host: this.publicConnection(hostId) };
  }

  async closeSession(session) {
    session.closed = true;
    session.clearReconnect();
    session.abort?.abort(operationCancelled());
    await session.closeTransport();
    this.sessions.delete(session.hostId);
  }

  async buildPreview(runtime, signal) {
    if (!runtime.host?.client || runtime.host.closed) {
      throw error('HOST_NOT_CONNECTED', 'Connect the SSH host before previewing synchronization.');
    }
    const record = this.store.require(runtime.hostId);
    const descriptors = this.settings.describe({ redactSecrets: true });
    const credentialRefs = record.syncPolicy.allSupported === false ? [] : discoverCredentialRefs(descriptors);
    const localCredentials = Object.fromEntries(await Promise.all(credentialRefs.map(async (ref) => {
      if (typeof this.credentials.describe !== 'function') return [ref, { configured: true, writable: true }];
      try {
        const descriptor = await this.credentials.describe(ref);
        return [ref, { configured: descriptor.configured === true, writable: descriptor.writable === true }];
      } catch {
        return [ref, { configured: false, writable: false }];
      }
    })));
    const client = runtime.host.client;
    const [remoteSettings, remotePlugins, remoteCredentials] = await Promise.all([
      client.post('/api/ssh-remote/settings/describe', {}),
      client.post('/api/ssh-remote/plugins/list', {}),
      client.post('/api/ssh-remote/credentials/describe', { refs: credentialRefs }),
    ]);
    signal.throwIfAborted();
    const bundles = await this.localBundles();
    return buildSyncPreview(record, {
      descriptors,
      bundles,
      localCredentials,
      remoteDescriptors: remoteSettings?.descriptors,
      remoteBundles: remotePlugins?.bundles,
      remoteCredentials: remoteCredentials?.credentials,
      target: runtime.artifact?.target,
      dshVersion: runtime.host.version,
    });
  }

  previewSync(hostId) {
    const runtime = this.runtime(hostId);
    this.store.require(hostId);
    if (runtime.phase !== 'connected') {
      return Promise.reject(error('HOST_NOT_CONNECTED', 'Connect the SSH host before previewing synchronization.'));
    }
    if (runtime.operation) return Promise.reject(error('HOST_BUSY', 'Another operation is running for this SSH host.'));
    runtime.preview = null;
    const promise = bounded((signal) => this.buildPreview(runtime, signal), {
      timeoutMs: this.syncTimeoutMs,
      onController: (controller) => { runtime.abort = controller; },
    }).then((preview) => {
      runtime.preview = preview;
      return preview;
    });
    runtime.operation = promise;
    return promise.finally(() => {
      if (runtime.operation === promise) runtime.operation = null;
    });
  }

  sync(hostId, { allowConflicts = false } = {}) {
    const runtime = this.runtime(hostId);
    this.store.require(hostId);
    if (runtime.operation) return Promise.reject(error('HOST_BUSY', 'Another operation is running for this SSH host.'));
    if (typeof allowConflicts !== 'boolean') return Promise.reject(error('INVALID_REQUEST', 'allowConflicts must be boolean.'));
    const promise = bounded((signal) => this.performSync(runtime, signal, { allowConflicts }), {
      timeoutMs: this.syncTimeoutMs,
      onController: (controller) => { runtime.abort = controller; },
    }).catch((cause) => {
      if (runtime.phase === 'syncing') this.transition(runtime, 'connected', cause);
      throw cause;
    });
    runtime.operation = promise;
    return promise.finally(() => {
      if (runtime.operation === promise) runtime.operation = null;
    });
  }

  async restartConnectedHost(runtime, originalHost) {
    const oldInstanceId = originalHost.instanceId;
    this.closingHosts.add(originalHost);
    await originalHost.close();
    await originalHost.controller.stop({ instanceId: oldInstanceId });
    const replacement = new this.RemoteHostConnection({
      channel: originalHost.channel,
      controller: originalHost.controller,
      version: originalHost.version,
      buildId: originalHost.buildId,
      workspace: originalHost.workspace,
      patch: originalHost.patch,
      profileId: originalHost.profileId,
      fetchImpl: originalHost.fetchImpl,
    });
    try {
      await replacement.open();
      if (replacement.instanceId === oldInstanceId) {
        throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The plugin restart returned the old remote instance.');
      }
      runtime.host = replacement;
      runtime.channel = replacement.channel;
      runtime.controller = replacement.controller;
      this.observeHost(runtime, replacement);
      await this.store.markConnected(runtime.hostId, {
        instanceId: replacement.instanceId,
        version: replacement.version,
        buildId: replacement.buildId,
      });
      return replacement;
    } catch (cause) {
      await replacement.close().catch(() => {});
      runtime.host = null;
      this.transition(runtime, 'failed', cause);
      throw cause;
    }
  }

  async performSync(runtime, signal, { allowConflicts = false, initial = false, profileId = DEFAULT_PROFILE_ID } = {}) {
    if (!runtime.host?.client || runtime.host.closed || !ACTIVE_PHASES.has(runtime.phase)) {
      throw error('HOST_NOT_CONNECTED', 'Connect the SSH host before synchronizing it.');
    }
    this.transition(runtime, 'syncing');
    const record = this.store.require(runtime.hostId);
    if (!initial && !allowConflicts && runtime.preview?.requiresConfirmation) {
      throw error('SYNC_CONFIRMATION_REQUIRED', 'Remote user settings conflict with the reviewed sync plan. Set allowConflicts=true to overwrite those fields.', { preview: runtime.preview });
    }
    const preview = initial ? await this.buildPreview(runtime, signal) : runtime.preview;
    const { requiresMerge, mergeReasons } = mergeAssessment(preview);
    const bundles = await this.localBundles();
    const input = await buildSyncInput(record, {
      descriptors: this.settings.describe({ redactSecrets: true }),
      resolveCredential: (ref) => this.credentials.resolve(ref),
      describeCredential: (ref) => this.credentials.describe?.(ref),
      bundles,
    });
    if (preview) {
      for (const setting of input.settings) {
        const operation = preview.operations.find((item) => item.type === 'settings' && item.ns === setting.ns);
        if (typeof operation?.remoteRevision === 'number') setting.expectedRevision = operation.remoteRevision;
      }
    }
    let backup = null;
    if (initial && requiresMerge) {
      backup = backupMetadata(await this.createRemoteBackup(runtime.host.client, profileId));
    }
    signal.throwIfAborted();
    const originalHost = runtime.host;
    let report = await this.syncRemote(originalHost.client, input);
    signal.throwIfAborted();
    if (report.restartRequired) {
      const oldInstanceId = originalHost.instanceId;
      const replacement = await this.restartConnectedHost(runtime, originalHost);
      const resumed = await this.syncRemote(replacement.client, { ...input, plugins: [] });
      report = {
        ok: report.plugins.ok && resumed.ok,
        restartRequired: false,
        restarted: true,
        previousInstanceId: oldInstanceId,
        instanceId: replacement.instanceId,
        plugins: report.plugins,
        settings: resumed.settings,
        credentials: resumed.credentials,
      };
    }
    let pluginSharing;
    try {
      pluginSharing = await this.shareLocalPlugins(runtime.host.client, bundles);
    } catch (cause) {
      pluginSharing = { ok: false, error: publicError(cause) };
    }
    signal.throwIfAborted();
    if (sharingNeedsRestart(pluginSharing)) {
      const oldInstanceId = runtime.host.instanceId;
      const replacement = await this.restartConnectedHost(runtime, runtime.host);
      try {
        if (!pluginSharing.snapshot) throw error('PLUGIN_SNAPSHOT_MISSING', 'The remote plugin restart requires a local plugin snapshot.');
        await this.uploadLocalPluginSnapshot(replacement.client, pluginSharing.snapshot);
        pluginSharing = { ...pluginSharing, restartRequired: false, snapshotRestored: true };
      } catch (cause) {
        pluginSharing = { ...pluginSharing, ok: false, restartRequired: false, snapshotRestored: false, error: publicError(cause) };
      }
      report = { ...report, restarted: true, previousInstanceId: oldInstanceId, instanceId: replacement.instanceId };
    }
    report = {
      ...report,
      ok: report.ok && sharingSucceeded(pluginSharing),
      pluginSharing,
      backup,
      requiresMerge,
      mergeReasons,
    };
    runtime.sync = report;
    runtime.preview = null;
    if (report.ok) await this.store.markSynced(runtime.hostId);
    this.transition(runtime, 'ready');
    this.transition(runtime, 'connected');
    return report;
  }

  async stop(hostId, { instanceId } = {}) {
    const runtime = this.runtime(hostId);
    const record = this.store.require(hostId);
    if (runtime.operation) throw error('HOST_BUSY', 'Wait for the current host operation to finish before stopping it.');
    const targetId = instanceId ?? runtime.host?.instanceId ?? record.lastInstanceId;
    if (!targetId) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'No remote instance is recorded for this host.');
    if (instanceId && instanceId !== (runtime.host?.instanceId ?? record.lastInstanceId)) {
      throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The requested instance does not match the saved host instance.');
    }
    return bounded(async (signal) => {
      this.clearReconnect(runtime);
      let session;
      try {
        const activeHost = runtime.host;
        const activeController = activeHost?.controller ?? runtime.controller;
        if (activeHost) {
          this.closingHosts.add(activeHost);
          await activeHost.close();
          runtime.host = null;
        }
        if (activeController) {
          await activeController.stop({ instanceId: targetId });
          // Dropping a shared transport would silently orphan the other profile hosts.
          const session = this.sessions.get(hostId);
          const shared = Boolean(session?.connected && session.channel === activeControllerChannel(activeHost, runtime));
          if (!shared) {
            if (runtime.channel && !runtime.channel.closed) await runtime.channel.close();
            if (session) await this.closeSession(session);
          }
        } else {
          session = await this.openControllerSession({
            alias: record.hostAlias,
            catalog: this.catalog,
            version: await this.localVersion(),
            ...this.interactiveOptions(runtime, false, signal),
          });
          await session.controller.stop({ instanceId: targetId });
        }
        await this.store.clearInstance(hostId);
        const adopted = this.profileRuntimeByInstance(hostId, targetId);
        if (adopted) {
          this.closingHosts.add(adopted.host ?? {});
          adopted.host = null;
          adopted.instanceId = null;
          adopted.phase = 'idle';
          this.profileRuntimes(hostId).delete(adopted.profileId);
        }
        runtime.channel = null;
        runtime.controller = null;
        runtime.sync = null;
        this.transition(runtime, 'idle');
        return { ok: true, stoppedInstanceId: targetId, host: this.publicConnection(hostId) };
      } catch (cause) {
        this.transition(runtime, 'failed', cause);
        throw cause;
      } finally {
        if (session) await session.channel.close().catch(() => {});
      }
    }, { timeoutMs: this.stopTimeoutMs });
  }

  listPorts(hostId) {
    this.store.require(hostId);
    return listPortForwards(this, hostId);
  }

  addPort(hostId, input) {
    this.store.require(hostId);
    return addPortForward(this, hostId, input);
  }

  removePort(hostId, id) {
    this.store.require(hostId);
    return removePortForward(this, hostId, id);
  }

  diagnostics(hostId) {
    return createRemoteDiagnosticReport(this, hostId);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.autoConnectTimer);
    for (const session of [...this.sessions.values()]) {
      session.clearReconnect();
      session.abort?.abort(operationCancelled());
      await session.closeTransport();
    }
    this.sessions.clear();
    for (const runtime of this.runtimes.values()) {
      this.clearReconnect(runtime);
      this.interactions.cancelHost(runtime.hostId);
      runtime.abort?.abort(operationCancelled());
      await this.releaseRuntime(runtime);
    }
    this.removeAllListeners();
  }
}
