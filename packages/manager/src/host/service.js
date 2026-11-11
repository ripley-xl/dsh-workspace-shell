import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';

import { publicError, safeMessage } from './diagnostics.js';
import { addPortForward, createRemoteDiagnosticReport, listPortForwards, removePortForward } from './service-extensions.js';
import {
  appendRemotePatch, planPatchSync, readLocalProfileDependencies, readLocalProfilePatch, readRemoteProfilePatch,
} from './remote-config.js';
import { resolveGuestInterpreter, startGuestHost, waitForProfileCard } from './guest-hosts.js';
import {
  filterLivePids, forwardedUrl, installRemotePlugin as installRemotePluginOverSsh, planDiscoveredSync, publicHost,
  readRemoteHostCards, readRemoteProfileDependencies, respawnRemoteProcess,
  terminateRemoteProcess, waitForReplacementCard,
} from './remote-hosts.js';
import { authenticationCallbacks, InteractionBroker, interactiveHostKeyVerifier } from './interactions.js';
import { DEFAULT_PROFILE_ID, defaultProfiles, instanceRuntimeMatches, matchesProfile, normalizeInstanceList, normalizeProfileId, normalizeProfiles } from './profiles.js';
import { createLatestVersionCache, isNewerVersion } from './registry.js';
import { SharedStart } from './shared-start.js';
import { SshRemoteError, operationCancelled, operationTimeout } from './ssh/errors.js';

const ACTIVE_PHASES = new Set(['installing', 'upgrading', 'syncing', 'ready', 'switching', 'connected', 'reconnecting']);
const PHASE_PRIORITY = ['failed', 'reconnecting', 'upgrading', 'installing', 'syncing', 'switching', 'starting', 'ready', 'connected', 'idle'];
const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;
const DEFAULT_SYNC_TIMEOUT_MS = 180_000;
const DEFAULT_STOP_TIMEOUT_MS = 150_000;
const MAX_PROFILE_HOSTS = 16;
const MAX_UPGRADE_PLUGINS = 64;
const MAX_UPGRADE_ITEMS = 32;
const UPGRADE_PHASES = new Set(['running', 'done', 'failed']);
const UPGRADE_STEPS = new Set(['runtime', 'plugins']);
const REGISTRY_PROTOCOL_SPEC = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const LOCAL_SPEC_PATH = /(?:^|[\s("'=])\/(?:[^\s/]+[\\/])+[^\s]*|^[A-Za-z]:[\\/]|^~[\\/]/u;
const TARBALL_SPEC = /\.(?:tgz|tar\.gz|tar|zip)(?:$|[?#])/iu;
const UNSAFE_SPEC_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@|[?&](?:access_?token|api_?key|auth|credential|password|secret|token)=/iu;

function error(code, message, details) {
  return new SshRemoteError(code, message, { details });
}

const FAILED_APPLICATIONS = new Set(['failed', 'cancelled']);

const SOURCE_INSTALL = /^(?:github:|git:|git\+|file:|link:|https?:\/\/)/iu;
const CONFIG_SECRET_KEY = /(?:key|token|secret|password|passphrase|credential|authorization|cookie)/iu;
const CONFIG_LOCAL_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|file:|link:)/iu;
const MAX_CONFIG_ENTRIES = 32;
const MAX_CONFIG_DEPTH = 6;
const MAX_CONFIG_KEYS = 64;
const MAX_CONFIG_ARRAY = 64;
const MAX_CONFIG_STRING = 2048;

/** The package a config entry belongs to: `@scope/pkg/sub` -> `@scope/pkg`. */
function pluginOfModuleName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.startsWith('@')) {
    const parts = name.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : name;
  }
  return name.split('/')[0];
}

/** Drops secrets and machine-local values before a config block leaves the host. */
function configValue(value, depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) return undefined;
  if (typeof value === 'string') {
    if (value.length > MAX_CONFIG_STRING) return undefined;
    return CONFIG_LOCAL_PATH.test(value.trim()) ? undefined : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONFIG_ARRAY).map((item) => configValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (value === null || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_CONFIG_KEYS)) {
    if (CONFIG_SECRET_KEY.test(key)) continue;
    const cleaned = configValue(item, depth + 1);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

/** The install spec a remote bundle was installed from, if it reports one. */
function bundleInstallSource(bundle) {
  if (typeof bundle?.source === 'string' && bundle.source) return bundle.source;
  if (typeof bundle?.spec === 'string' && bundle.spec) return bundle.spec;
  return null;
}

function remoteInstallFailed(value) {
  return value?.ok === false || FAILED_APPLICATIONS.has(value?.result?.application);
}

/**
 * Installs one plugin on the remote Host and returns the raw response.
 *
 * DSH installs the package before it re-enables the plugin row. When the
 * previous version was removed in the same operation, the first enable can
 * still resolve the removed bundle and report `application: 'failed'` at stage
 * `enable` — the package is already on disk by then. One more install of the
 * same spec re-runs enable against the new package and succeeds, so that case
 * is retried once. Install-stage failures and pending build approvals are real
 * verdicts and are returned as they are.
 */
async function installRemotePlugin(getClient, { spec, approvedBuilds = null, retryEnableFailure = true }) {
  // The client is resolved per request: a plugin action can apply through HMR
  // and replace the connection between the failed attempt and the retry.
  const request = () => {
    const client = getClient();
    if (!client) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The remote Host is no longer connected.');
    return client.post('/api/ssh-remote/plugins/install', {
      spec,
      requestId: randomUUID(),
      ...Array.isArray(approvedBuilds) && approvedBuilds.length > 0 ? { approvedBuilds: approvedBuilds.slice(0, 16) } : {},
    });
  };
  const response = await request();
  if (!retryEnableFailure || !remoteInstallFailed(response) || response?.result?.stage !== 'enable') return response;
  return request();
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

/** Bounds the automatic plugin alignment result before it leaves the service. */
function publicPluginAlignment(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (input, max) => typeof input === 'string' ? input.slice(0, max) : null;
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, 32).map((item) => {
    const name = text(item?.name, 256);
    if (!name) return null;
    const code = text(item?.error?.code, 64);
    return {
      name,
      fromVersion: text(item?.fromVersion, 128),
      toVersion: text(item?.toVersion, 128),
      ok: item?.ok === true,
      application: text(item?.application, 64),
      ...code ? { error: { code } } : {},
    };
  }).filter(Boolean);
  const skipped = (Array.isArray(value.skipped) ? value.skipped : []).slice(0, 32).map((item) => {
    const name = text(item?.name, 256);
    if (!name) return null;
    return { name, reason: text(item?.reason, 64) };
  }).filter(Boolean);
  const code = text(value?.error?.code, 64);
  return {
    ok: value.ok === true,
    items,
    skipped,
    restarted: value.restarted === true,
    ...code ? { error: { code } } : {},
  };
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

function safeErrorCode(cause, fallback = 'REMOTE_OPERATION_FAILED') {
  const code = publicError(cause)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : fallback;
}

function upgradeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= 256 && !/[\0\r\n]/u.test(name) ? name : null;
}

/** The package name a plain registry spec installs, or `null` for source specs. */
function registryPackageName(spec) {
  if (typeof spec !== 'string' || spec.length === 0 || REGISTRY_PROTOCOL_SPEC.test(spec)) return null;
  if (spec.startsWith('/') || LOCAL_SPEC_PATH.test(spec) || TARBALL_SPEC.test(spec) || UNSAFE_SPEC_URL.test(spec)) return null;
  const at = spec.lastIndexOf('@');
  if (at > 0) {
    const version = spec.slice(at + 1);
    if (!version || version.includes('/') || version.includes(':')) return null;
  }
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name.includes('/') && !name.startsWith('@') ? null : name || null;
}

/**
 * The upgrade target for a remote bundle, or `null` when it must be skipped:
 * official packages follow the runtime, and source/credential specs never go
 * to the registry.
 */
function registryUpgradeName(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const name = upgradeName(bundle.name);
  if (!name) return null;
  if (bundle.official === true || name.startsWith('@deepseek-ai/')) return null;
  const spec = typeof bundle.installTarget?.spec === 'string' ? bundle.installTarget.spec : bundle.spec;
  if (typeof spec !== 'string' || registryPackageName(spec) !== name) {
    // A bundle without an explicit spec may still be a plain registry install
    // named after the package itself.
    if (typeof spec === 'string' && spec.length > 0) return null;
  }
  return name;
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
    this.transportMode = 'controller';
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
    // Guest transport has no controller: the SSH channel is the whole transport.
    return Boolean(this.channel && !this.channel.closed && (this.controller || this.transportMode === 'guest'));
  }

  get busy() {
    return Boolean(this.operation || this.starting);
  }

  attachTransport(session) {
    const previous = this.channel;
    this.channel = session.channel;
    this.controller = session.controller ?? null;
    this.transportMode = session.transportMode ?? (session.controller ? 'controller' : 'guest');
    this.installed = session.installed;
    this.artifact = session.artifact;
    this.target = session.target;
    // Re-attaching the same channel (an in-place upgrade reuses it) must not
    // stack duplicate close handlers, and a replaced channel must no longer
    // clear the transport that replaced it.
    if (previous !== this.channel) {
      previous?.off('close', this.onChannelClose);
      this.channel.once('close', this.onChannelClose);
      if (previous && !previous.closed) void previous.close().catch(() => {});
    }
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
    this.localVersion = options.localVersion;
    this.localReturnUrl = cleanLocalReturnUrl(options.localReturnUrl);
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.localBundles = options.localBundles ?? (async () => []);
    this.transport = 'guest';
    this.openGuestChannel = options.openGuestChannel ?? (async (options2) => {
      const module = await import('./ssh/connection.js');
      const channel = options2.channel ?? await module.connectSsh(options2.alias, {
        signal: options2.signal,
        interactive: options2.interactive,
        background: options2.background,
        authCallbacks: options2.authCallbacks,
        hostKeyVerifier: options2.hostKeyVerifier,
      });
      return { channel, controller: null, installed: null, artifact: null, target: null, transportMode: 'guest' };
    });
    // The profile on this machine that a foreign Host of the same name should
    // match. Falls back to the standard DSH home.
    this.localHome = options.localHome ?? (() => process.env.DSH_HOME ?? path.join(homedir(), '.dsh'));
    this.configEditor = options.configEditor ?? null;
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
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    // Remote plugin upgrades resolve npm `latest` locally; tests may inject a
    // plain resolver. Results are shared and cached for ten minutes.
    this.versionCache = options.versionCache ?? createLatestVersionCache({ fetch: options.fetch, ttlMs: options.versionTtlMs });
    this.latestVersion = options.latestVersion ?? ((name) => this.versionCache.latest(name));
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
        upgrade: null,
        latestDshVersion: null,
      });
    }
    const runtime = this.runtimes.get(hostId);
    const session = this.sessions.get(hostId);
    if (session) {
      runtime.channel = session.channel;
      runtime.controller = session.controller;
      runtime.installed = session.installed;
      runtime.artifact = session.artifact;
      runtime.target = session.target;
    }
    return runtime;
  }

  /** All opened Web profiles of a host, keyed by instanceId. */
  session(hostId) {
    if (!this.sessions.has(hostId)) {
      const record = this.store.require(hostId);
      this.sessions.set(hostId, new HostSession({ hostId, alias: record.hostAlias }));
    }
    return this.sessions.get(hostId);
  }

  /** Refreshes the cached profile list; failures keep the previous cache. */
  /** Reads the newest bundled runtime for one host's target, if it is known. */
  /**
   * Public upgrade progress. `phase`, `step` and a safe error code only; the
   * fixed step values are mapped to localized copy by the client.
   */
  /** `done` is visible for one poll, then cleared so the row shows the new version. */
  /** Keeps the legacy single-host view pointed at the upgraded default Host. */

  /** Actions connect on demand instead of making the user find the toggle first. */
  async ensureConnected(hostId) {
    if (this.session(hostId).connected) return;
    await this.connect(hostId, { background: false });
    if (!this.session(hostId).connected) throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
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
    if (session.connected) await this.refreshGuestProfiles(session);
    const hosts = await this.guestProfileHosts(hostId);
    return {
      ok: true,
      profiles: session.profiles?.length ? session.profiles : defaultProfiles(),
      profilesSource: session.profiles?.length ? 'remote' : 'default',
      connected: session.connected,
      hosts,
      latestDshVersion: null,
      upgrade: null,
      hostAlias: record.hostAlias,
    };
  }

  /** Turns one live card into an attachable Host through a loopback forward. */
  async adoptGuestHost(hostId, card, { signal } = {}) {
    const existing = listPortForwards(this, hostId)
      .find((forward) => forward.state === 'active' && forward.remotePort === card.port && forward.remoteHost === '127.0.0.1');
    const forward = existing ?? await addPortForward(this, hostId, {
      name: `guest-${card.instanceId.slice(0, 8)}`,
      remotePort: card.port,
    });
    if (!forward || !Number.isInteger(forward.localPort) || forward.localPort < 1) {
      throw error('TUNNEL_FAILED', 'The port forward did not become active.');
    }
    return {
      ok: true,
      guest: true,
      instanceId: card.instanceId,
      profileId: card.profileId,
      profileName: card.profileId,
      pid: card.pid,
      port: card.port,
      state: 'running',
      url: forwardedUrl(card.url, forward.localPort),
    };
  }

  /**
   * The guest path for opening a profile: adopt a Host that already reports
   * itself, or start one with the remote machine's own `dsh`. Returns null when
   * this Host cannot be served this way (no channel, no dsh, version mismatch),
   * which keeps the controller path as the fallback until it is removed.
   */
  async guestProfileHost(hostId, profileId, { signal, reuseOnly = false } = {}) {
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) return null;
    const { hosts } = await readRemoteHostCards(runtime.channel, { signal }).catch(() => ({ hosts: [] }));
    const candidates = hosts.filter((card) => card.profileId === profileId && card.supervised !== true);
    if (candidates.length) {
      const alive = await filterLivePids(runtime.channel, candidates.map((card) => card.pid), { signal });
      const live = candidates.filter((card) => alive.has(card.pid))
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
      if (live) return this.adoptGuestHost(hostId, live, { signal });
    }
    if (reuseOnly) return null;
    const interpreter = await resolveGuestInterpreter(runtime.channel, { profileId, signal }).catch(() => null);
    if (!interpreter?.version) return null;
    let local = null;
    try { local = await this.localVersion(); } catch { local = null; }
    // A version we cannot vouch for is refused here; the controller fallback
    // can still pin its own runtime for hosts that need one.
    if (typeof local === 'string' && local && interpreter.version !== local) return null;
    const workspace = (() => {
      try { return runtime.session?.installed?.home ?? null; } catch { return null; }
    })();
    await startGuestHost(runtime.channel, { interpreter, profileId, workspace: workspace ?? '/tmp' }, { signal });
    const card = await waitForProfileCard(runtime.channel, { profileId }, { signal });
    if (!card) throw error('REMOTE_HOST_START_FAILED', 'The Host did not report itself after starting.');
    return this.adoptGuestHost(hostId, card, { signal });
  }

  /** Opens or reuses the single healthy Host of one Web profile. */
  async webOpen(hostId, { profileId = DEFAULT_PROFILE_ID, profileName, signal, reuseOnly = false } = {}) {
    await this.ensureConnected(hostId);
    const id = normalizeProfileId(profileId);
    this.store.require(hostId);
    if (this.closed) throw error('SERVICE_DISPOSED', 'The SSH Remote service is disposed.');
    const profiles = this.sessions.get(hostId)?.profiles;
    const known = profiles?.find((profile) => profile.id === id);
    if (profiles?.length && (!known || known.web !== true)) {
      throw error('PROFILE_NOT_WEB', 'The selected profile is not a Web profile.', { profileId: id });
    }
    const hostRuntime = this.runtime(hostId);
    if (!hostRuntime.channel || hostRuntime.channel.closed) {
      throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    }
    const guest = await this.guestProfileHost(hostId, id, { signal, reuseOnly });
    if (guest) return guest;
    throw error('REMOTE_HOST_START_FAILED', 'No remote dsh was found to start this Web Host.', { profileId: id });
  }

  /** The controller-managed start path, kept as the fallback until it is removed. */
  /** Returns the private Guest URL only for a Host this manager already holds. */
  /**
   * Hosts on the remote machine that were not started by this manager. The
   * cards are read over SSH; only validated ones are returned, and never with
   * their authenticated URL.
   */
  async discoveredHosts(hostId, { signal } = {}) {
    this.store.require(hostId);
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) {
      throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    }
    const { hosts, skipped } = await readRemoteHostCards(runtime.channel, { signal });
    // A Host that already has a profile row must not show up again under
    // "other hosts"; supervised cards are controller leftovers, and a card can
    // outlive its process when the Host is killed.
    const managed = new Set((await this.guestProfileHosts(hostId, { signal }))
      .map((host) => host.instanceId).filter(Boolean));
    const candidates = hosts.filter((card) => card.supervised !== true && !managed.has(card.instanceId));
    const alive = await filterLivePids(runtime.channel, candidates.map((card) => card.pid), { signal });
    return {
      ok: true,
      hosts: candidates.filter((card) => alive.has(card.pid)).map(publicHost),
      skipped: [...skipped, ...hosts.filter((card) => card.supervised === true).map((card) => ({ instanceId: card.instanceId, code: 'HOST_CARD_SUPERVISED' }))],
    };
  }

  /** Shared guard: the card must exist, be alive, and not be controller-managed. */
  async requireDiscoveredCard(hostId, instanceId, signal) {
    await this.ensureConnected(hostId);
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) {
      throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    }
    if (typeof instanceId !== 'string' || !/^[a-f0-9]{32}$/u.test(instanceId)) {
      throw error('INVALID_REQUEST', 'instanceId is required.');
    }
    const { hosts } = await readRemoteHostCards(runtime.channel, { signal });
    const card = hosts.find((host) => host.instanceId === instanceId);
    if (!card || card.supervised === true) {
      throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The discovered Host is no longer available.');
    }
    const alive = await filterLivePids(runtime.channel, [card.pid], { signal });
    if (!alive.has(card.pid)) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The discovered Host is no longer running.');
    return { runtime, card };
  }

  /** Stops a reported Host by signalling its process after the card check. */
  async stopDiscovered(hostId, { instanceId, signal } = {}) {
    await this.ensureConnected(hostId);
    this.store.require(hostId);
    const { runtime, card } = await this.requireDiscoveredCard(hostId, instanceId, signal);
    const stopped = await terminateRemoteProcess(runtime.channel, card.pid, { signal });
    if (!stopped) throw error('REMOTE_OPERATION_FAILED', 'The discovered Host did not stop.');
    return { ok: true, instanceId: card.instanceId, profileId: card.profileId, stopped: true };
  }

  /**
   * Restarts a reported Host with its own command line. The card carries argv
   * and cwd, so the replacement is exactly what the user started — no guessed
   * runtime, no controller involvement.
   */
  async restartDiscovered(hostId, { instanceId, signal } = {}) {
    await this.ensureConnected(hostId);
    this.store.require(hostId);
    const { runtime, card } = await this.requireDiscoveredCard(hostId, instanceId, signal);
    return this.restartDiscoveredCard(runtime, card, { signal });
  }

  /** Stops and replays one already-validated card. */
  async restartDiscoveredCard(runtime, card, { signal } = {}) {
    const stopped = await terminateRemoteProcess(runtime.channel, card.pid, { signal });
    if (!stopped) throw error('REMOTE_OPERATION_FAILED', 'The discovered Host did not stop.');
    const spawned = await respawnRemoteProcess(runtime.channel, { argv: card.argv, cwd: card.cwd }, { signal });
    if (!spawned) throw error('REMOTE_OPERATION_FAILED', 'The discovered Host command could not be started.');
    const replacement = await waitForReplacementCard(runtime.channel, {
      hostKey: card.hostKey, profileId: card.profileId, previousInstanceId: card.instanceId,
    }, { signal });
    if (!replacement) throw error('REMOTE_OPERATION_FAILED', 'The discovered Host did not come back.');
    return {
      ok: true,
      instanceId: replacement.instanceId,
      previousInstanceId: card.instanceId,
      profileId: replacement.profileId,
      pid: replacement.pid,
      port: replacement.port,
    };
  }

  /**
   * Brings a reported Host's profile in line with this machine using the remote
   * `dsh` the Host was started with — no bundled runtime, no controller.
   * Only missing plugins and genuine upgrades are installed; a newer remote
   * plugin, a local path spec, and Desktop-only packages are left alone.
   */
  async syncDiscovered(hostId, { instanceId, signal } = {}) {
    await this.ensureConnected(hostId);
    this.store.require(hostId);
    const { runtime, card } = await this.requireDiscoveredCard(hostId, instanceId, signal);
    const remoteDependencies = await readRemoteProfileDependencies(runtime.channel, card.profileId, { signal });
    // The Desktop profile's whole dependency list is the baseline: bundles alone
    // miss ordinary plugins (image-gen, recall, model packs), which is why their
    // config entries could never resolve on the Host.
    const home = this.localHome() ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
    const desktopDeps = await readLocalProfileDependencies(home, 'desktop').catch(() => null);
    const localBundles = desktopDeps
      ? Object.entries(desktopDeps).map(([name, spec]) => ({
        name,
        version: String(spec).replace(/^[\^~]/u, ''),
        official: name.startsWith('@deepseek-ai/'),
        enabled: true,
      }))
      : await this.localBundles().catch(() => []);
    const plan = planDiscoveredSync({ localBundles, remoteDependencies });
    const items = [];
    for (const entry of plan.install) {
      const result = await installRemotePluginOverSsh(runtime.channel, {
        argv: card.argv, profileId: card.profileId, spec: entry.spec,
      }, { signal }).catch((cause) => ({ ok: false, code: null, detail: safeMessage(cause) }));
      items.push({ name: entry.name, spec: entry.spec, reason: entry.reason, ok: result.ok, detail: result.detail || '' });
    }
    // Configuration: append what the same-name local profile declares and the
    // remote lacks. Existing remote entries are never rewritten.
    let config = { appended: [], backup: null, error: null };
    try {
      // The Desktop is the maintained source: every Host is aligned to its
      // patch, not to this machine's same-name profile (which lags behind).
      const localText = await readLocalProfilePatch(home, 'desktop').catch(() => '');
      const remoteText = await readRemoteProfilePatch(runtime.channel, card.profileId, { signal });
      const plan = planPatchSync({ localText, remoteText });
      config = { appended: [], skipped: plan.skipped, backup: null, error: null };
      if (plan.append.length) {
        const applied = await appendRemotePatch(runtime.channel, {
          argv: card.argv, profileId: card.profileId, remoteText, entries: plan.append, signal,
        });
        config = { ...config, ...applied, skipped: plan.skipped };
      }
    } catch (cause) {
      config = { appended: [], backup: null, error: safeMessage(cause) };
    }
    const changed = items.some((item) => item.ok) || config.appended.length > 0;
    let restarted = null;
    if (changed) restarted = await this.restartDiscoveredCard(runtime, card, { signal }).catch(() => null);
    return {
      ok: true,
      profileId: card.profileId,
      items,
      skipped: plan.skipped,
      config,
      restarted: restarted ? { instanceId: restarted.instanceId, pid: restarted.pid, port: restarted.port } : null,
      changed,
    };
  }

  /**
   * Opens one discovered Host through a loopback forward: the card's URL is
   * rewritten onto the local port so the page keeps its token and its origin
   * shape. Repeated attaches reuse an existing forward for the same port.
   */
  async attachDiscovered(hostId, { instanceId, signal } = {}) {
    this.store.require(hostId);
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) {
      throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    }
    if (typeof instanceId !== 'string' || !/^[a-f0-9]{32}$/u.test(instanceId)) {
      throw error('INVALID_REQUEST', 'instanceId is required.');
    }
    const { hosts } = await readRemoteHostCards(runtime.channel, { signal });
    const card = hosts.find((host) => host.instanceId === instanceId);
    if (!card || card.supervised === true) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The discovered Host is no longer running.');
    const alive = await filterLivePids(runtime.channel, [card.pid], { signal });
    if (!alive.has(card.pid)) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The discovered Host is no longer running.');
    const existing = listPortForwards(this, hostId)
      .find((forward) => forward.state === 'active' && forward.remotePort === card.port && forward.remoteHost === '127.0.0.1');
    const forward = existing ?? await addPortForward(this, hostId, {
      name: `workspace-host-${instanceId.slice(0, 8)}`,
      remotePort: card.port,
    });
    if (!forward || !Number.isInteger(forward.localPort) || forward.localPort < 1) {
      throw error('TUNNEL_FAILED', 'The port forward did not become active.');
    }
    return {
      ok: true,
      instanceId: card.instanceId,
      profileId: card.profileId,
      url: forwardedUrl(card.url, forward.localPort),
      forwardId: forward.id,
    };
  }

  async webAttach(hostId, { instanceId } = {}) {
    await this.ensureConnected(hostId);
    this.store.require(hostId);
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      throw error('INVALID_REQUEST', 'instanceId is required.');
    }
    const source = this.runtime(hostId);
    if (!source.channel || source.channel.closed) throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    const { hosts } = await readRemoteHostCards(source.channel, {}).catch(() => ({ hosts: [] }));
    const card = hosts.find((item) => item.instanceId === instanceId && item.supervised !== true);
    if (card) {
      const alive = await filterLivePids(source.channel, [card.pid], {});
      if (alive.has(card.pid)) return this.adoptGuestHost(hostId, card, {});
    }
    throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The requested Web Host is not running.', { instanceId });
  }

  /** Confirms one known instance is still healthy for its profile. */
  /**
   * Finds the profile of a remote instance this manager does not hold yet.
   * The controller scopes every list to one profile, so each known profile is
   * queried; unknown instances stay unavailable rather than being guessed.
   */
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

  /** Stops one profile Host; other profile Hosts of the same SSH connection stay up. */
  /** Stops a guest-started Host by signalling the process behind its card. */
  async stopGuestHost(hostId, instanceId) {
    const source = this.runtime(hostId);
    if (source.channel && !source.channel.closed) {
      const { hosts } = await readRemoteHostCards(source.channel, {}).catch(() => ({ hosts: [] }));
      const card = hosts.find((item) => item.instanceId === instanceId && item.supervised !== true);
      if (card) {
        const stopped = await terminateRemoteProcess(source.channel, card.pid, {});
        if (!stopped) throw error('REMOTE_OPERATION_FAILED', 'The Host did not stop.');
        return { ok: true, instanceId: card.instanceId, profileId: card.profileId, stopped: true };
      }
    }
    throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The requested Web Host is not managed by this manager.', { instanceId });
  }

  webStop(hostId, { instanceId } = {}) {
    this.store.require(hostId);
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return Promise.reject(error('INVALID_REQUEST', 'instanceId is required.'));
    }
    return this.ensureConnected(hostId).then(() => this.stopGuestHost(hostId, instanceId));
  }

  /**
   * Starts upgrading one remote Web Host: when a newer bundled runtime exists
   * for its target it is installed on the shared channel and the Host is
   * replaced, then non-official registry plugins are raised to npm `latest`.
   * Returns immediately; progress is polled through status/web-list.
   */
  /**
   * Approves the recorded pending build scripts and retries the plugin
   * upgrade. Approvals are applied per plugin, because the remote installer
   * rejects approvals that are no longer pending for that plugin.
   */
  /**
   * Raises every installed non-official registry plugin to npm `latest`
   * without rolling back per-plugin failures. A single `restart-required`
   * result restarts the upgraded Host once, at the end.
   */
  /**
   * Non-official registry plugins whose npm `latest` is newer than the
   * installed one. `null` means the Host could not be read.
   */
  /** Cached, non-blocking "are remote plugins behind npm" probe for the row. */
  /** Shareable local plugins that the remote profile has installed too. */
  /** Config blocks of the given plugins, read from the local profile. */
  /** Settings namespaces that belong to the given plugins. */
  /**
   * Pushes the configuration of the plugins this upgrade touched: their config
   * entries and their settings namespaces. Only plugins in `names` are sent, so
   * unrelated local configuration never reaches the remote profile.
   */
  /**
   * Installs one planned plugin on the remote profile. A plugin that replaces
   * an existing version is removed first; the old version is restored when the
   * replacement fails, so the profile is never left without the plugin.
   */
  /**
   * Uploads the local plugin snapshot the remote plugin page lists as "local".
   * The snapshot lives in the remote Host's memory, so a replaced or restarted
   * Host starts with an empty list until the manager sends it again. A failure
   * here never blocks the connection: the remote page just has no local list.
   */
  async ensureTransport(session, options = {}) {
    if (session.connected) return session;
    this.debugLog(`transport: begin for ${session.hostId}`);
    if (session.operation) return session.operation;
    const record = this.store.require(session.hostId);
    const preferredVersion = await this.localVersion().catch((cause) => {
      this.debugLog(`transport: localVersion failed ${cause?.code ?? ''}`);
      return null;
    });
    this.debugLog(`transport: localVersion=${String(preferredVersion).slice(0, 24)}`);
    const interactive = options.interactive !== false && options.background !== true;
    const promise = bounded((signal) => this.openSessionTransport(session, record, {
      version: preferredVersion,
      interactive,
      background: options.background === true,
      signal,
    }), {
      timeoutMs: options.timeoutMs ?? this.connectTimeoutMs,
      onController: (controller) => { session.abort = controller; },
    });
    session.operation = promise;
    try {
      const done = await promise;
      this.debugLog(`transport: ok for ${session.hostId}`);
      return done;
    } catch (cause) {
      this.debugLog(`transport: failed ${cause?.code ?? ''} ${String(cause?.message ?? cause).slice(0, 120)}`);
      throw cause;
    } finally {
      if (session.operation === promise) session.operation = null;
      session.abort = null;
    }
  }

  async openSessionTransport(session, record, options) {
    const { interactive, background, signal } = options;
    const opened = await this.openGuestChannel({
      alias: record.hostAlias,
      interactive,
      background,
      signal,
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
      remoteVersion: runtime.host?.version ?? record.lastServerVersion ?? null,
      dshVersion: runtime.host?.version ?? record.lastServerVersion ?? null,
      remoteBuildId: runtime.host?.buildId ?? null,
      latestDshVersion: null,
      upgrade: null,
      pluginAlignment: null,
      connected: Boolean(session?.connected),
      error: runtime.error ?? null,
      sync: runtime.sync,
      reconnectAttempts: runtime.reconnectAttempts,
      portForwards: runtime.portManager?.list() ?? runtime.portForwards ?? [],
      profiles: [],
      autoConnect: record.autoConnect === true,
    };
  }

  /** Startup diagnostics land next to the route errors; failures are otherwise silent. */
  debugLog(message) {
    try {
      const file = path.join(homedir(), '.dsh', 'ssh-remote', 'logs', 'auto-connect.log');
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, new Date().toISOString() + ' ' + message + '\n');
    } catch { /* diagnostics never break the service */ }
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
    const runtimes = this.store.list().map((record) => this.runtime(record.id));
    const connections = runtimes.map((runtime) => this.publicConnection(runtime.hostId));
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
  /**
   * Records written before auto-connect became the default store `false`
   * explicitly; a host that never connected is migrated by treating it as on.
   * Once it connects, `lastConnectedAt` marks the preference as real.
   */
  wantsAutoConnect(record) {
    if (!record) return false;
    if (record.autoConnect === true) return true;
    return record.autoConnect === false && record.lastConnectedAt === null;
  }

  scheduleAutoConnect(hostId) {
    if (this.closed || !this.store.get(hostId)) return;
    if (this.autoConnectAttempts.has(hostId)) return;
    this.autoConnectAttempts.add(hostId);
    const timer = setTimeout(() => {
      if (this.closed || !this.store.get(hostId)) return;
      const record = this.store.get(hostId);
      if (!record || !this.wantsAutoConnect(record)) return;
      const runtime = this.runtime(hostId);
      if (runtime.operation || runtime.host) return;
      this.connect(hostId, { background: true }).catch((cause) => {
        this.debugLog(`auto-connect failed for ${hostId}: ${cause?.code ?? ''} ${String(cause?.message ?? cause).slice(0, 200)}`);
      });
    }, 0);
    timer.unref?.();
  }

  async autoConnectAll() {
    if (this.closed) return { ok: true, attempted: 0 };
    this.autoConnectStarted = true;
    const records = this.store.list().filter((record) => this.wantsAutoConnect(record));
    for (const record of records) this.scheduleAutoConnect(record.id);
    this.debugLog(`auto-connect: ${records.length} record(s) scheduled`);
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

  connect(hostId, { background = false, reconnectInstanceId, profileId = DEFAULT_PROFILE_ID } = {}) {
    const runtime = this.runtime(hostId);
    if (runtime.operation) return runtime.operation;
    this.clearReconnect(runtime);
    const promise = bounded((signal) => this.performConnect(runtime, {
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

  /**
   * Removes what the old controller transport left on the remote machine:
   * bundled runtimes, instance records, leases and logs. Refuses while a
   * controller-managed Host is still running — its supervisor owns that.
   */
  async cleanupRemoteRuntime(hostId, { signal } = {}) {
    await this.ensureConnected(hostId);
    this.store.require(hostId);
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) {
      throw error('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
    }
    const { hosts } = await readRemoteHostCards(runtime.channel, { signal }).catch(() => ({ hosts: [] }));
    const alive = await filterLivePids(runtime.channel, hosts.filter((card) => card.supervised === true).map((card) => card.pid), { signal })
      .catch(() => new Set());
    if (alive.size > 0) {
      throw error('REMOTE_RUNTIME_IN_USE', 'A controller-managed Host is still running; stop it before cleaning up.');
    }
    const sizeRun = await runtime.channel.exec({
      command: 'sh',
      args: ['-c', 'du -sk "$HOME/.dsh/ssh-remote" 2>/dev/null | cut -f1'],
      signal,
    }).catch(() => ({ stdout: '' }));
    const kilobytes = Number(String(sizeRun.stdout).trim()) || 0;
    const removed = await runtime.channel.exec({
      command: 'sh',
      args: ['-c', 'cd "$HOME/.dsh/ssh-remote" 2>/dev/null || exit 0; rm -rf servers instances locks logs tmp; printf "%s\\n" "$HOME/.dsh/ssh-remote"'],
      signal,
    });
    if (removed.code !== 0) throw error('REMOTE_RUNTIME_CLEANUP_FAILED', 'The remote runtime directory could not be cleaned up.');
    return { ok: true, freedBytes: kilobytes * 1024, root: String(removed.stdout).trim() || null };
  }

  /** Guest transport: open the SSH channel and stop there — no runtime, no controller. */
  async performConnect(runtime, options) {
    return this.performGuestConnect(runtime, options);
  }

  async performGuestConnect(runtime, { signal, background = false } = {}) {
    this.debugLog(`guest-connect: start ${runtime.hostId}`);
    this.transition(runtime, 'installing');
    try {
      const session = await this.ensureProfileTransport(runtime.hostId, { background });
      this.debugLog(`guest-connect: transport ready ${runtime.hostId}`);
      signal?.throwIfAborted?.();
      this.transition(runtime, 'connected');
      return { ok: true, host: this.publicConnection(runtime.hostId), browserUrl: null };
    } catch (cause) {
      this.transition(runtime, 'failed', cause);
      throw cause;
    }
  }

  /** Web profiles the remote machine declares, read from its profile manifests. */
  async refreshGuestProfiles(session) {
    try {
      const listed = await session.channel.exec({
        command: 'sh',
        args: ['-c', 'ls -1 "$HOME/.dsh/profiles" 2>/dev/null || true'],
        maxStdoutBytes: 64 * 1024,
      });
      const ids = String(listed.stdout).split('\n').map((line) => line.trim())
        .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(line)).slice(0, 64);
      const profiles = [];
      for (const id of ids) {
        const manifest = await session.channel.exec({
          command: 'sh',
          args: ['-c', `cat "$HOME/.dsh/profiles/${id}/package.json" 2>/dev/null || true`],
          maxStdoutBytes: 256 * 1024,
        }).catch(() => ({ stdout: '' }));
        let bundles = [];
        try {
          const value = JSON.parse(String(manifest.stdout));
          bundles = Array.isArray(value?.dsh?.profile?.bundles) ? value.dsh.profile.bundles : [];
        } catch { continue; }
        if (!bundles.includes('@deepseek-ai/dsh-web-app')) continue;
        profiles.push({ id, name: id, web: true });
      }
      session.profiles = profiles.length ? profiles : null;
    } catch {
      session.profiles = session.profiles ?? null;
    }
    return session.profiles ?? null;
  }

  /** One running row per profile, built from the Host cards. */
  async guestProfileHosts(hostId, { signal } = {}) {
    const runtime = this.runtime(hostId);
    if (!runtime.channel || runtime.channel.closed) return [];
    const { hosts } = await readRemoteHostCards(runtime.channel, { signal }).catch(() => ({ hosts: [] }));
    if (!hosts.length) return [];
    const alive = await filterLivePids(runtime.channel, hosts.map((card) => card.pid), { signal }).catch(() => new Set());
    const byProfile = new Map();
    for (const card of hosts) {
      if (!alive.has(card.pid)) continue;
      const current = byProfile.get(card.profileId);
      if (!current || Date.parse(card.startedAt) > Date.parse(current.startedAt)) byProfile.set(card.profileId, card);
    }
    return [...byProfile.values()].sort((left, right) => left.profileId.localeCompare(right.profileId)).map((card) => ({
      instanceId: card.instanceId,
      profileId: card.profileId,
      profileName: card.profileId,
      pid: card.pid,
      port: card.port,
      state: 'running',
      phase: 'running',
      health: { healthy: true, connected: true, hostAlive: true, supervisorAlive: false },
      views: 0,
      dshVersion: null,
      connected: true,
    }));
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
        // A transient transport failure is retried; after the attempt limit
        // the connection is reported as failed.
        if (runtime.reconnectAttempts >= this.maxReconnectAttempts) {
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
    if (session) await this.closeSession(session);
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

  /**
   * Stops one remote Host and opens a replacement on the same shared channel
   * and controller. Profile Hosts use the profile runtime bookkeeping; the
   * default Web Host also updates the stored connection record.
   */
  async stop(hostId, { instanceId } = {}) {
    const runtime = this.runtime(hostId);
    const record = this.store.require(hostId);
    if (runtime.operation) throw error('HOST_BUSY', 'Wait for the current host operation to finish before stopping it.');
    const targetId = instanceId ?? runtime.host?.instanceId ?? record.lastInstanceId;
    if (!targetId) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'No remote instance is recorded for this host.');
    const result = await this.stopGuestHost(hostId, targetId);
    await this.store.clearInstance(hostId).catch(() => {});
    runtime.host = null;
    runtime.phase = 'idle';
    this.publish(hostId);
    return { ...result, host: this.publicConnection(hostId) };
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
      if (runtime.channel && !runtime.channel.closed) await runtime.channel.close().catch(() => {});
    }
    this.removeAllListeners();
  }
}
