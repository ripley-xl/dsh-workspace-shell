import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';

import { openRemoteHost, writeStatusPluginPatch } from './open-remote-host.js';
import { openControllerSession } from './controller-session.js';
import { buildPluginAlignmentPlan, planPluginSync, shareableLocalPluginNames } from './plugin-alignment.js';
import { RemoteHostConnection } from './remote-host.js';
import { syncRemote, syncRemoteSettings } from './remote-sync.js';
import { buildSyncInput, buildSyncPreview, discoverCredentialRefs } from './sync-input.js';
import { publicError, safeMessage } from './diagnostics.js';
import { addPortForward, createRemoteDiagnosticReport, listPortForwards, removePortForward } from './service-extensions.js';
import {
  appendRemotePatch, planPatchSync, readLocalProfilePatch, readRemoteProfilePatch,
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
    this.catalog = options.catalog;
    this.localVersion = options.localVersion;
    this.localReturnUrl = cleanLocalReturnUrl(options.localReturnUrl);
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.localBundles = options.localBundles ?? (async () => []);
    // The plugin passes 'guest' by default; a bare service (tests, library
    // callers) keeps the controller path until the last of it is deleted.
    this.transport = options.transport === 'guest' ? 'guest' : 'controller';
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
    this.openRemoteHost = options.openRemoteHost ?? openRemoteHost;
    this.openControllerSession = options.openControllerSession ?? openControllerSession;
    this.RemoteHostConnection = options.RemoteHostConnection ?? RemoteHostConnection;
    this.syncRemote = options.syncRemote ?? syncRemote;
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
    const runtimes = [...this.profileRuntimes(hostId).values()]
      .filter((runtime) => runtime.instanceId || (runtime.host && !runtime.host.closed));
    for (const runtime of runtimes) void this.refreshPluginUpgrades(runtime).catch(() => {});
    return runtimes
      .map((runtime) => this.publicProfileHost(runtime))
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  publicProfileHost(runtime) {
    const host = runtime.host && !runtime.host.closed ? runtime.host : null;
    const healthy = Boolean(host && runtime.phase === 'running');
    const hostRuntime = this.runtimes.get(runtime.hostId);
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
      dshVersion: host?.version ?? null,
      latestDshVersion: hostRuntime?.latestDshVersion ?? null,
      pluginsUpgradable: runtime.pluginsOutdated === true,
      buildApprovals: Array.isArray(runtime.buildApprovals) ? runtime.buildApprovals : [],
      upgrade: this.upgradeSnapshot(hostRuntime, runtime.profileId),
      error: runtime.error ?? null,
    };
  }

  /** Reads the newest bundled runtime for one host's target, if it is known. */
  async refreshLatestDshVersion(runtime) {
    const target = runtime.target ?? runtime.artifact?.target ?? this.sessions.get(runtime.hostId)?.target ?? null;
    if (!target || typeof this.catalog?.newest !== 'function') {
      runtime.latestDshVersion = null;
      return null;
    }
    try {
      const artifact = await this.catalog.newest({ target });
      runtime.latestDshVersion = artifact?.dshVersion ?? null;
    } catch {
      runtime.latestDshVersion = null;
    }
    return runtime.latestDshVersion;
  }

  /**
   * Public upgrade progress. `phase`, `step` and a safe error code only; the
   * fixed step values are mapped to localized copy by the client.
   */
  upgradeSnapshot(runtime, profileId = null) {
    const state = runtime?.upgrade;
    if (!state || !UPGRADE_PHASES.has(state.phase)) return null;
    if (profileId && state.profileId && state.profileId !== profileId) return null;
    const step = UPGRADE_STEPS.has(state.step) ? state.step : null;
    const errorCode = typeof state.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(state.error.code)
      ? state.error.code
      : null;
    const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
    const items = (Array.isArray(state.items) ? state.items : []).slice(0, MAX_UPGRADE_ITEMS).map((item) => {
      const name = text(item?.name, 256);
      if (!name) return null;
      const itemCode = typeof item?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item.error.code)
        ? item.error.code
        : null;
      return {
        name,
        fromVersion: text(item?.fromVersion, 128),
        toVersion: text(item?.toVersion, 128),
        ok: item?.ok === true,
        ...typeof item?.application === 'string' ? { application: item.application.slice(0, 64) } : {},
        ...itemCode ? { error: { code: itemCode } } : {},
        ...Array.isArray(item?.pendingBuilds) && item.pendingBuilds.length > 0
          ? { pendingBuilds: item.pendingBuilds.filter((value) => typeof value === 'string').slice(0, 8) }
          : {},
      };
    }).filter(Boolean);
    return {
      phase: state.phase,
      step,
      ...errorCode ? { error: { code: errorCode } } : {},
      ...items.length ? { items } : {},
    };
  }

  /** `done` is visible for one poll, then cleared so the row shows the new version. */
  prepareUpgradeReport(runtime) {
    if (runtime?.upgrade?.phase === 'done' && runtime.upgrade.reported === true) runtime.upgrade = null;
  }

  finishUpgradeReport(runtime) {
    if (runtime?.upgrade?.phase === 'done') runtime.upgrade.reported = true;
  }

  /** Keeps the legacy single-host view pointed at the upgraded default Host. */
  syncDefaultProfileHost(runtime, profileId, host, session = this.sessions.get(runtime.hostId)) {
    if (profileId !== DEFAULT_PROFILE_ID || !host) return;
    const previous = runtime.host;
    runtime.host = host;
    if (session) {
      runtime.channel = session.channel;
      runtime.controller = session.controller;
      runtime.installed = session.installed;
      runtime.artifact = session.artifact;
    }
    if (previous !== host) this.observeHost(runtime, host);
  }

  currentProfileVersion(runtime, profileRuntime, profileId = DEFAULT_PROFILE_ID) {
    const host = profileRuntime?.host && !profileRuntime.host.closed ? profileRuntime.host : null;
    if (host?.version) return host.version;
    if (profileId === DEFAULT_PROFILE_ID && runtime.host && !runtime.host.closed) return runtime.host.version ?? null;
    const record = this.store.get(runtime.hostId);
    return profileId === DEFAULT_PROFILE_ID ? record?.lastServerVersion ?? null : null;
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
    const runtime = this.runtime(hostId);
    if (this.transport === 'guest') {
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
    if (session.connected) await this.refreshProfiles(session);
    await this.refreshLatestDshVersion(runtime);
    this.prepareUpgradeReport(runtime);
    const hosts = this.profileHosts(hostId);
    this.finishUpgradeReport(runtime);
    return {
      ok: true,
      profiles: session.profiles?.length ? session.profiles : defaultProfiles(),
      profilesSource: session.profiles?.length ? 'remote' : 'default',
      connected: session.connected,
      hosts,
      latestDshVersion: runtime.latestDshVersion ?? null,
      upgrade: this.upgradeSnapshot(runtime),
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
    // Guest path: the Host reports itself; we adopt it instead of starting a
    // second, controller-managed one.
    // The channel lives on the Host runtime, not on the per-profile record.
    const hostRuntime = this.runtime(hostId);
    if (hostRuntime.channel && !hostRuntime.channel.closed && !runtime.start) {
      // Only a "cannot serve this way" answer falls back; a real failure (the
      // Host did not come back) is reported instead of being papered over.
      const guest = await this.guestProfileHost(hostId, id, { signal, reuseOnly });
      if (guest) return guest;
    }
    if (this.transport === 'guest') {
      throw error('REMOTE_HOST_START_FAILED', 'No remote dsh was found to start this Web Host (guest transport).', { profileId: id });
    }
    return this.openViaController(hostId, id, runtime, { signal, reuseOnly });
  }

  /** The controller-managed start path, kept as the fallback until it is removed. */
  openViaController(hostId, id, runtime, { signal, reuseOnly = false } = {}) {
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
    // Controller-started Hosts write cards too, and a card outlives its process
    // when the Host is killed. Neither belongs in "other hosts": the first is
    // already a row of its own, the second is not running at all.
    const managed = new Set(this.profileHosts(hostId).map((host) => host.instanceId).filter(Boolean));
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
    this.store.require(hostId);
    const { runtime, card } = await this.requireDiscoveredCard(hostId, instanceId, signal);
    const remoteDependencies = await readRemoteProfileDependencies(runtime.channel, card.profileId, { signal });
    const localBundles = await this.localBundles().catch(() => []);
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
      const home = this.localHome() ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
      const localText = await readLocalProfilePatch(home, card.profileId).catch(() => '');
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
    // A managed instance already has an attach path; do not shadow it.
    if (this.profileHosts(hostId).some((host) => host.instanceId === instanceId)) {
      throw error('REMOTE_INSTANCE_UNAVAILABLE', 'That Host is managed by this connection; attach it through its row.');
    }
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
    this.store.require(hostId);
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      throw error('INVALID_REQUEST', 'instanceId is required.');
    }
    const runtime = this.profileRuntimeByInstance(hostId, instanceId);
    if (runtime?.host && !runtime.host.closed && runtime.phase === 'running') {
      return this.publicWebHost(runtime);
    }
    // A Host started through the guest path has no controller runtime; its card
    // is the only record, and a forward is all it needs to be attached again.
    if (!runtime) {
      const source = this.runtime(hostId);
      if (source.channel && !source.channel.closed) {
        const { hosts } = await readRemoteHostCards(source.channel, {}).catch(() => ({ hosts: [] }));
        const card = hosts.find((item) => item.instanceId === instanceId && item.supervised !== true);
        if (card) {
          const alive = await filterLivePids(source.channel, [card.pid], {});
          if (alive.has(card.pid)) return this.adoptGuestHost(hostId, card, {});
        }
      }
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
    let session = null;
    let host = null;
    let existing = null;
    try {
      session = await this.ensureProfileTransport(hostId, { background: false });
      runtime.session = session;
      signal.throwIfAborted();
      if (this.closed) throw operationCancelled(signal);
      const preferredVersion = await this.localVersion();
      const artifact = session.artifact ?? await this.catalog.select({
        version: preferredVersion,
        target: session.target,
        signal,
      });
      signal.throwIfAborted();
      const listed = normalizeInstanceList(await session.controller.list({ version: artifact.dshVersion, buildId: artifact.buildId, profileId }));
      existing = listed.find((instance) => instance.profileId === profileId
        && instance.health.healthy
        && instance.state !== 'stopped'
        && instanceRuntimeMatches(instance, artifact.runtimeId));
      if (!existing && reuseOnly) {
        // Reuse-only never replaces a Host: an older instance is not adoptable.
        throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The recorded remote Host is no longer available for this profile.', {
          profileId,
          instanceId: runtime.instanceId ?? null,
        });
      }
      // This path also starts Hosts; it needs the same status-plugin overlay as
      // the default connect path. Without it the new Host has no
      // /api/ssh-remote/status endpoint and the attach below fails every time.
      const patch = existing
        ? null
        : await writeStatusPluginPatch(session.channel, {
          installed: session.installed,
          hostAlias: this.store.require(hostId).hostAlias,
          localReturnUrl: this.localReturnUrl,
          dshVersion: artifact.dshVersion,
          signal,
        });
      host = new this.RemoteHostConnection({
        channel: session.channel,
        controller: session.controller,
        version: artifact.dshVersion,
        buildId: artifact.buildId,
        runtimeId: artifact.runtimeId,
        workspace: session.installed?.home,
        patch,
        startMode: existing ? 'reuse-only' : 'auto',
        profileId,
      });
      await host.open();
      // The last waiter cancelled before the Host became ready. The catch below
      // closes this Host and stops only an instance this call started.
      if (signal.aborted || runtime.phase !== 'starting') {
        throw operationCancelled(signal);
      }
      runtime.host = host;
      runtime.instanceId = host.instanceId;
      runtime.phase = 'running';
      this.observeProfileHost(runtime, host);
      runtime.pluginAlignment = await this.alignRemotePlugins(runtime, { profileId });
      this.publish(hostId);
      const alignment = publicPluginAlignment(runtime.pluginAlignment);
      return { ...this.publicWebHost(runtime), ...alignment ? { pluginAlignment: alignment } : {} };
    } catch (cause) {
      // A Host this call started must not survive a failed start: it carries
      // this connection's overlay and would otherwise be reused by later opens.
      const startedInstanceId = existing ? null : host?.startedInstanceId ?? null;
      if (host) await host.close().catch(() => {});
      if (startedInstanceId && session?.controller) {
        await session.controller.stop({ instanceId: startedInstanceId }).catch(() => {});
      }
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
    const runtime = this.profileRuntimeByInstance(hostId, instanceId);
    // Guest-started Hosts have no controller runtime; their card is the record.
    if (!runtime) return this.stopGuestHost(hostId, instanceId);
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

  /**
   * Starts upgrading one remote Web Host: when a newer bundled runtime exists
   * for its target it is installed on the shared channel and the Host is
   * replaced, then non-official registry plugins are raised to npm `latest`.
   * Returns immediately; progress is polled through status/web-list.
   */
  async upgradeHost({ hostId, profileId } = {}) {
    const record = this.store.require(hostId);
    if (this.transport === 'guest') {
      throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'Guest transport has no bundled runtime; use plugin sync on the Host instead.');
    }
    if (this.closed) throw error('SERVICE_DISPOSED', 'The SSH Remote service is disposed.');
    const id = normalizeProfileId(profileId ?? DEFAULT_PROFILE_ID);
    const runtime = this.runtime(hostId);
    if (runtime.upgrade?.phase === 'running' || runtime.operation) {
      throw error('UPGRADE_BUSY', 'Another upgrade or connection operation is running for this SSH host.');
    }
    const profiles = this.sessions.get(hostId)?.profiles;
    const known = profiles?.find((profile) => profile.id === id);
    if (profiles?.length && (!known || known.web !== true)) {
      throw error('UPGRADE_UNSUPPORTED_PROFILE', 'The selected profile is not a Web profile.', { profileId: id });
    }
    const profileRuntime = this.profileRuntime(hostId, id, known?.name);
    const target = this.runtimeTarget(runtime);
    const current = this.currentProfileVersion(runtime, profileRuntime, id);
    let newest = null;
    if (target && typeof this.catalog?.newest === 'function') {
      try {
        newest = await this.catalog.newest({ target });
      } catch {
        newest = null;
      }
    }
    if (newest) runtime.latestDshVersion = newest.dshVersion;
    if (target && !newest) {
      throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'No bundled runtime package matches this remote target.');
    }
    if (newest && current && !isNewerVersion(newest.dshVersion, current)) {
      // The runtime is current, but a connected Host may still have plugins
      // behind npm latest; those are upgraded without replacing the runtime.
      const connected = profileRuntime.host && !profileRuntime.host.closed ? profileRuntime.host : null;
      const plan = connected?.client ? await this.pluginUpgradePlan(connected).catch(() => null) : null;
      if (!plan || plan.length === 0) {
        return {
          started: false,
          reason: 'up-to-date',
          hostId: record.id,
          profileId: id,
          dshVersion: current,
          latestDshVersion: newest.dshVersion,
        };
      }
    }
    const upgrade = { phase: 'running', step: 'runtime', profileId: id, error: null, items: [], reported: false };
    runtime.buildApprovals = runtime.buildApprovals ?? [];
    runtime.upgrade = upgrade;
    this.publish(hostId);
    void this.performHostUpgrade(runtime, upgrade, { profileId: id }).catch(() => {});
    return { started: true, upgrade: this.upgradeSnapshot(runtime, id) };
  }

  /**
   * Approves the recorded pending build scripts and retries the plugin
   * upgrade. Approvals are applied per plugin, because the remote installer
   * rejects approvals that are no longer pending for that plugin.
   */
  async approveUpgrades({ hostId, profileId } = {}) {
    const record = this.store.require(hostId);
    if (this.closed) throw error('SERVICE_DISPOSED', 'The SSH Remote service is disposed.');
    const id = normalizeProfileId(profileId ?? DEFAULT_PROFILE_ID);
    const runtime = this.runtime(hostId);
    if (runtime.upgrade?.phase === 'running' || runtime.operation) {
      throw error('UPGRADE_BUSY', 'Another upgrade or connection operation is running for this SSH host.');
    }
    const profileRuntime = this.profileRuntime(hostId, id);
    const approvals = Array.isArray(profileRuntime.buildApprovals) ? profileRuntime.buildApprovals : [];
    if (approvals.length === 0) {
      throw error('UPGRADE_APPROVAL_UNAVAILABLE', 'No remote plugin is waiting for build-script approval.', { profileId: id });
    }
    const upgrade = {
      phase: 'running',
      step: 'plugins',
      profileId: id,
      error: null,
      items: [],
      reported: false,
      approvedBuildsByPlugin: new Map(approvals.map((entry) => [entry.name, [...entry.builds]])),
    };
    runtime.upgrade = upgrade;
    this.publish(hostId);
    void this.performHostUpgrade(runtime, upgrade, { profileId: id }).catch(() => {});
    return { started: true, approved: approvals.length, hostId: record.id, profileId: id, upgrade: this.upgradeSnapshot(runtime, id) };
  }

  runtimeTarget(runtime) {
    return runtime.target ?? runtime.artifact?.target ?? this.sessions.get(runtime.hostId)?.target ?? null;
  }

  setUpgradeStep(runtime, upgrade, step) {
    if (runtime.upgrade !== upgrade || upgrade.phase !== 'running') return;
    upgrade.step = step;
    this.publish(runtime.hostId);
  }

  async performHostUpgrade(runtime, upgrade, { profileId }) {
    const hostId = runtime.hostId;
    try {
      const session = await this.ensureProfileTransport(hostId, { background: true });
      if (upgrade !== runtime.upgrade) return;
      const target = this.runtimeTarget(runtime) ?? session.target;
      if (!target) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The remote runtime target is unavailable.');
      const newest = typeof this.catalog?.newest === 'function' ? await this.catalog.newest({ target }) : null;
      if (!newest) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'No bundled runtime package matches this remote target.');
      runtime.latestDshVersion = newest.dshVersion;
      const profileRuntime = this.profileRuntime(hostId, profileId);
      const current = this.currentProfileVersion(runtime, profileRuntime, profileId);
      let host = profileRuntime.host && !profileRuntime.host.closed ? profileRuntime.host : null;
      if (!current || isNewerVersion(newest.dshVersion, current)) {
        this.setUpgradeStep(runtime, upgrade, 'runtime');
        const record = this.store.require(hostId);
        // Reopening the controller on the shared channel installs the newer
        // runtime package before this manager detaches its held Host. Other
        // profile Hosts on the same SSH connection keep running.
        const opened = await this.openControllerSession({
          channel: session.channel,
          alias: record.hostAlias,
          catalog: this.catalog,
          version: newest.dshVersion,
          interactive: false,
          background: true,
          authCallbacks: authenticationCallbacks(this.interactions, hostId),
          hostKeyVerifier: interactiveHostKeyVerifier(this.interactions, hostId),
        });
        if (opened.artifact.dshVersion !== newest.dshVersion) {
          throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The newest remote runtime package could not be installed.');
        }
        session.attachTransport(opened);
        if (upgrade !== runtime.upgrade) return;
        await this.startProfileHost(profileRuntime, new AbortController().signal);
        host = profileRuntime.host;
        if (!host || host.closed) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The upgraded remote Host is unavailable.');
        if (profileId === DEFAULT_PROFILE_ID) {
          this.syncDefaultProfileHost(runtime, profileId, host, session);
          await this.store.markConnected(hostId, {
            instanceId: host.instanceId,
            version: host.version,
            buildId: host.buildId,
          });
          if (runtime.phase !== 'connected' && runtime.phase !== 'failed') this.transition(runtime, 'connected');
        }
      }
      this.setUpgradeStep(runtime, upgrade, 'plugins');
      const report = await this.upgradeRemotePlugins(runtime, { profileId, host, approvedBuildsByPlugin: upgrade.approvedBuildsByPlugin });
      // The row is projected from the per-profile runtime, not the connection.
      profileRuntime.pluginsOutdated = false;
      profileRuntime.pluginCheck = null;
      profileRuntime.buildApprovals = report.items
        .filter((entry) => Array.isArray(entry.pendingBuilds) && entry.pendingBuilds.length > 0)
        .map((entry) => ({ name: entry.name, builds: entry.pendingBuilds.slice(0, 8) }))
        .slice(0, 16);
      const failed = report.items.find((item) => item.ok !== true);
      const errorCode = failed?.error?.code ?? report.error?.code
        ?? (report.config?.ok === false ? 'UPGRADE_CONFIG_FAILED' : null);
      runtime.upgrade = {
        phase: errorCode ? 'failed' : 'done',
        step: 'plugins',
        profileId,
        error: errorCode ? { code: errorCode } : null,
        items: report.items,
        reported: false,
      };
      this.publish(hostId);
    } catch (cause) {
      if (this.closed || upgrade !== runtime.upgrade) return;
      runtime.upgrade = {
        phase: 'failed',
        step: UPGRADE_STEPS.has(upgrade.step) ? upgrade.step : 'runtime',
        profileId,
        error: { code: safeErrorCode(cause, 'UPGRADE_RUNTIME_UNAVAILABLE') },
        items: Array.isArray(upgrade.items) ? upgrade.items : [],
        reported: false,
      };
      // The previous Host was detached before the replacement failed; do not
      // keep reporting a closed connection as connected.
      if (profileId === DEFAULT_PROFILE_ID && runtime.host?.closed) {
        runtime.host = null;
        runtime.channel = null;
        runtime.controller = null;
        runtime.phase = 'failed';
      }
      this.publish(hostId);
    }
  }

  /**
   * Raises every installed non-official registry plugin to npm `latest`
   * without rolling back per-plugin failures. A single `restart-required`
   * result restarts the upgraded Host once, at the end.
   */
  /**
   * Non-official registry plugins whose npm `latest` is newer than the
   * installed one. `null` means the Host could not be read.
   */
  async pluginUpgradePlan(host) {
    if (!host?.client) return null;
    const listed = await host.client.post('/api/ssh-remote/plugins/list', {});
    const bundles = Array.isArray(listed?.bundles) ? listed.bundles : [];
    const plan = [];
    for (const bundle of bundles.slice(0, MAX_UPGRADE_PLUGINS)) {
      const name = registryUpgradeName(bundle);
      if (!name) continue;
      // A git/file install reports no spec, but its source names the origin.
      // Those bundles are synced by their exact spec, never by npm latest.
      const installSource = bundleInstallSource(bundle);
      if (installSource && SOURCE_INSTALL.test(installSource)) continue;
      const fromVersion = typeof bundle.version === 'string' ? bundle.version : null;
      let latest = null;
      try {
        latest = await this.latestVersion(name);
      } catch {
        latest = null;
      }
      if (typeof latest !== 'string' || latest.length === 0) continue;
      if (fromVersion && !isNewerVersion(latest, fromVersion)) continue;
      plan.push({ kind: 'npm', name, fromVersion, toVersion: latest });
    }
    // Local plugins the remote profile does not have yet, or has at an older
    // version. Only registry and public source installs qualify; link:, file:
    // and tarball installs stay on this machine.
    const localBundles = await this.localBundles().catch(() => []);
    if (Array.isArray(localBundles) && localBundles.length > 0) {
      const sync = planPluginSync({ localBundles, remoteBundles: bundles });
      for (const operation of sync.operations.slice(0, MAX_UPGRADE_PLUGINS)) {
        plan.push({ kind: 'sync', ...operation });
      }
    }
    return plan;
  }

  /** Cached, non-blocking "are remote plugins behind npm" probe for the row. */
  async refreshPluginUpgrades(runtime) {
    const host = runtime.host && !runtime.host.closed ? runtime.host : null;
    if (!host?.client || runtime.upgrade?.phase === 'running') return;
    const nowMs = Date.now();
    const previous = runtime.pluginCheck;
    if (previous && (previous.pending || nowMs - previous.at < 60_000)) return;
    runtime.pluginCheck = { at: nowMs, pending: true };
    try {
      const plan = await this.pluginUpgradePlan(host);
      runtime.pluginsOutdated = Boolean(plan && plan.length);
    } catch {
      runtime.pluginsOutdated = false;
    } finally {
      runtime.pluginCheck = { at: Date.now(), pending: false };
    }
  }

  /** Shareable local plugins that the remote profile has installed too. */
  async sharedPluginNames(profileRuntime) {
    const localBundles = await this.localBundles().catch(() => []);
    const local = shareableLocalPluginNames(localBundles);
    if (local.size === 0) return local;
    const listed = await profileRuntime.host?.client?.post('/api/ssh-remote/plugins/list', {}).catch(() => null);
    const remote = new Set(
      (Array.isArray(listed?.bundles) ? listed.bundles : [])
        .filter((bundle) => bundle?.installed === true && typeof bundle.name === 'string')
        .map((bundle) => bundle.name),
    );
    return new Set([...local].filter((name) => remote.has(name)));
  }

  /** Config blocks of the given plugins, read from the local profile. */
  async collectPluginConfigEntries(names) {
    let editor = this.configEditor;
    if (typeof editor === 'function') {
      try {
        editor = editor();
      } catch {
        editor = null;
      }
    }
    if (!editor || typeof editor.configuration !== 'function' || names.size === 0) return [];
    let rows;
    try {
      rows = editor.configuration();
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    const entries = [];
    for (const row of rows) {
      const options = row?.entry?.options ?? row?.entry ?? {};
      const id = typeof options.id === 'string' ? options.id : null;
      const name = typeof options.name === 'string' ? options.name : null;
      if (!name || !names.has(pluginOfModuleName(name))) continue;
      const config = configValue(row?.override);
      if (!config || Object.keys(config).length === 0) continue;
      entries.push({ ...(id ? { id } : {}), name, config });
      if (entries.length >= MAX_CONFIG_ENTRIES) break;
    }
    return entries;
  }

  /** Settings namespaces that belong to the given plugins. */
  async pluginSettings(names, hostId) {
    if (names.size === 0) return [];
    const record = this.store.require(hostId);
    const bundles = await this.localBundles().catch(() => []);
    const input = await buildSyncInput(record, {
      descriptors: this.settings.describe({ redactSecrets: true }),
      resolveCredential: async () => null,
      describeCredential: (ref) => this.credentials.describe?.(ref),
      includeCredentialValues: false,
      bundles,
    });
    return (Array.isArray(input.settings) ? input.settings : [])
      .filter((setting) => names.has(pluginOfModuleName(setting.ns)))
      .slice(0, MAX_CONFIG_ENTRIES);
  }

  /**
   * Pushes the configuration of the plugins this upgrade touched: their config
   * entries and their settings namespaces. Only plugins in `names` are sent, so
   * unrelated local configuration never reaches the remote profile.
   */
  async syncPluginConfig(runtime, profileRuntime, { names } = {}) {
    const client = profileRuntime.host?.client;
    if (!client || !(names instanceof Set) || names.size === 0) return null;
    const report = { ok: true };
    try {
      const entries = await this.collectPluginConfigEntries(names);
      if (entries.length > 0) {
        const result = await client.post('/api/ssh-remote/plugins/config', { entries });
        report.entries = Array.isArray(result?.items)
          ? { ok: result.ok === true, items: result.items, restartRequired: result?.restartRequired === true }
          : { ok: true, items: [] };
        if (result && result.ok === false && Array.isArray(result.items)) report.ok = true; // per-entry misses are not a failed sync
      }
    } catch (cause) {
      report.entries = { ok: false, error: publicError(cause) };
      report.ok = false;
    }
    try {
      const settings = await this.pluginSettings(names, runtime.hostId);
      if (settings.length > 0) {
        const result = await syncRemoteSettings(client, settings);
        report.settings = { ok: result.ok, items: result.items };
        if (!result.ok) report.ok = false;
      }
    } catch (cause) {
      report.settings = { ok: false, error: publicError(cause) };
      report.ok = false;
    }
    return report;
  }

  /**
   * Installs one planned plugin on the remote profile. A plugin that replaces
   * an existing version is removed first; the old version is restored when the
   * replacement fails, so the profile is never left without the plugin.
   */
  async installRemotePluginPlan(profileRuntime, { name, spec, fromVersion, fromSpec = null, approvedBuilds = null }) {
    const client = () => profileRuntime.host?.client;
    if (!client()) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The remote Host is no longer connected.');
    if (!fromVersion && !fromSpec) return installRemotePlugin(client, { spec, approvedBuilds });
    const restored = fromSpec ?? `${name}@${fromVersion}`;
    const removed = await client().post('/api/ssh-remote/plugins/remove', { name });
    if (removed?.ok === false) throw error('UPGRADE_PLUGIN_FAILED', 'The remote plugin could not be replaced.');
    const restore = () => installRemotePlugin(client, { spec: restored, approvedBuilds, retryEnableFailure: false }).catch(() => {});
    let response;
    try {
      response = await installRemotePlugin(client, { spec, approvedBuilds });
    } catch (cause) {
      // A transport failure leaves the profile without the plugin just as a
      // rejected application does; put the previous version back either way.
      await restore();
      throw cause;
    }
    if (!remoteInstallFailed(response)) return response;
    // Roll back to the exact spec that was installed before, including a git pin.
    await restore();
    return response;
  }

  async upgradeRemotePlugins(runtime, { profileId, approvedBuildsByPlugin = null, signal = new AbortController().signal } = {}) {
    const profileRuntime = this.profileRuntime(runtime.hostId, profileId);
    const initial = profileRuntime.host && !profileRuntime.host.closed ? profileRuntime.host : null;
    if (!initial?.client) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The remote Host is not connected.');
    const listed = await initial.client.post('/api/ssh-remote/plugins/list', {});
    const bundles = Array.isArray(listed?.bundles) ? listed.bundles : [];
    const items = [];
    let restartRequired = false;
    // Resolve every npm latest first: a bundle installed from a git or file
    // source reports no spec, so it looks like a plain registry install until
    // npm has no dist-tag for it. When nothing resolves at all the registry is
    // unreachable and that is a real failure; when only some do, the misses are
    // non-npm installs and are left untouched.
    const candidates = [];
    for (const bundle of bundles.slice(0, MAX_UPGRADE_PLUGINS)) {
      const name = registryUpgradeName(bundle);
      if (!name) continue;
      // A git/file install reports no spec, but its source names the origin.
      // Those bundles are synced by their exact spec, never by npm latest.
      const installSource = bundleInstallSource(bundle);
      if (installSource && SOURCE_INSTALL.test(installSource)) continue;
      const fromVersion = typeof bundle.version === 'string' ? bundle.version : null;
      let latest = null;
      try {
        latest = await this.latestVersion(name);
      } catch {
        latest = null;
      }
      candidates.push({ name, fromVersion, latest: typeof latest === 'string' && latest.length > 0 ? latest : null });
    }
    const npmReachable = candidates.some((entry) => entry.latest !== null);
    for (const { name, fromVersion, latest } of candidates) {
      signal.throwIfAborted();
      if (latest === null) {
        if (!npmReachable) {
          items.push({ name, fromVersion, toVersion: null, ok: false, error: { code: 'UPGRADE_REGISTRY_UNAVAILABLE' } });
        }
        continue;
      }
      if (fromVersion && !isNewerVersion(latest, fromVersion)) continue;
      const item = { name, fromVersion, toVersion: latest, ok: false };
      try {
        const client = profileRuntime.host?.client;
        if (!client) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The remote Host is no longer connected.');
        const approved = approvedBuildsByPlugin instanceof Map ? approvedBuildsByPlugin.get(name) : null;
        const installAt = (version, options = {}) => installRemotePlugin(() => profileRuntime.host?.client, {
          spec: `${name}@${version}`,
          approvedBuilds: approved,
          ...options,
        });
        let response;
        if (fromVersion) {
          // DSH refuses to install a different version over an existing bundle,
          // so the plugin is replaced; a failed install puts the old version
          // back instead of leaving the profile without it.
          const removed = await client.post('/api/ssh-remote/plugins/remove', { name });
          if (removed?.ok === false) throw error('UPGRADE_PLUGIN_FAILED', 'The remote plugin could not be replaced.');
          let failure = null;
          try {
            response = await installAt(latest);
            const installed = response?.result ?? {};
            if (response?.ok === false || installed.application === 'failed' || installed.application === 'cancelled') failure = response;
          } catch (cause) {
            failure = cause;
          }
          if (failure) {
            // The rollback is a single attempt: the target version already
            // failed its enable, so retrying it is not a fresh verdict.
            await installAt(fromVersion, { retryEnableFailure: false }).catch(() => {});
            if (failure instanceof Error) throw failure;
          }
        } else {
          response = await installAt(latest);
        }
        const result = response?.result ?? {};
        if (response?.ok === false || result.application === 'failed' || result.application === 'cancelled') {
          const blocked = (Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [])
            .filter((value) => typeof value === 'string' && value.length > 0).slice(0, 16);
          if (blocked.length > 0) {
            // Build-script approval is the only actionable failure: keep the
            // names so the row can offer an explicit approve-and-retry.
            items.push({ ...item, error: { code: 'PLUGIN_BUILD_APPROVAL_REQUIRED' }, pendingBuilds: blocked });
            continue;
          }
          throw error('UPGRADE_PLUGIN_FAILED', 'The remote plugin could not be upgraded.', { remote: result.error?.code ?? null });
        }
        const pendingBuilds = (Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [])
          .filter((value) => typeof value === 'string' && value.length > 0).slice(0, 16);
        if (pendingBuilds.length > 0) {
          items.push({ ...item, error: { code: 'PLUGIN_BUILD_APPROVAL_REQUIRED' }, pendingBuilds });
          continue;
        }
        if (result.application === 'restart-required') restartRequired = true;
        items.push({
          ...item,
          ok: true,
          application: typeof result.application === 'string' ? result.application.slice(0, 64) : 'applied',
        });
      } catch {
        items.push({ ...item, error: { code: 'UPGRADE_PLUGIN_FAILED' } });
      }
    }
    if (items.length < MAX_UPGRADE_ITEMS) {
      // Local plugins the remote profile is missing. The local install spec is
      // reused as-is, so the remote ends up with the same plugin set the local
      // Host reports for registry and public source installs.
      const localBundles = await this.localBundles().catch(() => []);
      if (Array.isArray(localBundles) && localBundles.length > 0) {
        const fresh = await profileRuntime.host?.client?.post('/api/ssh-remote/plugins/list', {}).catch(() => null);
        const remoteBundles = Array.isArray(fresh?.bundles) ? fresh.bundles : bundles;
        const sync = planPluginSync({ localBundles, remoteBundles });
        for (const operation of sync.operations) {
          signal.throwIfAborted();
          if (items.length >= MAX_UPGRADE_ITEMS) break;
          const item = {
            name: operation.name,
            fromVersion: operation.fromVersion,
            toVersion: operation.toVersion ?? null,
            ok: false,
          };
          try {
            const approved = approvedBuildsByPlugin instanceof Map ? approvedBuildsByPlugin.get(operation.name) : null;
            const response = await this.installRemotePluginPlan(profileRuntime, {
              name: operation.name,
              spec: operation.spec,
              fromVersion: operation.fromVersion,
              fromSpec: operation.fromSpec ?? null,
              approvedBuilds: approved,
            });
            const result = response?.result ?? {};
            const pendingBuilds = (Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [])
              .filter((value) => typeof value === 'string' && value.length > 0).slice(0, 16);
            if (pendingBuilds.length > 0) {
              items.push({ ...item, error: { code: 'PLUGIN_BUILD_APPROVAL_REQUIRED' }, pendingBuilds });
              continue;
            }
            if (remoteInstallFailed(response)) {
              items.push({ ...item, error: { code: 'UPGRADE_PLUGIN_FAILED' } });
              continue;
            }
            if (result.application === 'restart-required') restartRequired = true;
            items.push({
              ...item,
              ok: true,
              application: typeof result.application === 'string' ? result.application.slice(0, 64) : 'applied',
            });
          } catch {
            items.push({ ...item, error: { code: 'UPGRADE_PLUGIN_FAILED' } });
          }
        }
      }
    }
    let restarted = false;
    let restartError = null;
    if (restartRequired && items.some((item) => item.ok)) {
      try {
        await this.restartHostForUpgrade(runtime, profileId);
        restarted = true;
      } catch (cause) {
        restartError = { code: safeErrorCode(cause, 'UPGRADE_RUNTIME_UNAVAILABLE') };
      }
    }
    // Plugins present on both sides plus the ones this run installed: their
    // config entries and settings follow. Local-only and Desktop-only plugins
    // stay out, so unrelated configuration never reaches the remote.
    const touched = new Set(items.filter((item) => item.ok === true).map((item) => item.name));
    const shared = await this.sharedPluginNames(profileRuntime);
    for (const name of shared) touched.add(name);
    let config = null;
    if (touched.size > 0 && profileRuntime.host && !profileRuntime.host.closed) {
      try {
        config = await this.syncPluginConfig(runtime, profileRuntime, { names: touched });
      } catch (cause) {
        config = { ok: false, error: publicError(cause) };
      }
    }
    if (config?.entries?.restartRequired === true && !restartError) {
      // A patch entry this sync created only activates after the Host reloads
      // its configuration.
      try {
        await this.restartHostForUpgrade(runtime, profileId);
        restarted = true;
      } catch (cause) {
        restartError = { code: safeErrorCode(cause, 'UPGRADE_RUNTIME_UNAVAILABLE') };
      }
    }
    return {
      ok: items.every((item) => item.ok) && !restartError && config?.ok !== false,
      items,
      restartRequired,
      restarted,
      ...restartError ? { error: restartError } : {},
      ...config ? { config } : {},
    };
  }

  /**
   * Uploads the local plugin snapshot the remote plugin page lists as "local".
   * The snapshot lives in the remote Host's memory, so a replaced or restarted
   * Host starts with an empty list until the manager sends it again. A failure
   * here never blocks the connection: the remote page just has no local list.
   */
  async refreshLocalPluginInventory(client) {
    if (!client || typeof client.post !== 'function') return false;
    try {
      const bundles = await this.localBundles();
      if (!Array.isArray(bundles) || bundles.length === 0) return false;
      const { createLocalPluginSnapshot } = await import('./plugin-share.js');
      await this.uploadLocalPluginSnapshot(client, createLocalPluginSnapshot(bundles));
      return true;
    } catch {
      return false;
    }
  }

  async restartHostForUpgrade(runtime, profileId) {
    const profileRuntime = this.profileRuntime(runtime.hostId, profileId);
    const original = profileRuntime.host && !profileRuntime.host.closed ? profileRuntime.host : null;
    if (!original) throw error('UPGRADE_RUNTIME_UNAVAILABLE', 'The upgraded remote Host is unavailable.');
    profileRuntime.session = profileRuntime.session ?? this.sessions.get(runtime.hostId) ?? null;
    const replacement = await this.restartHost(profileRuntime, original, { profile: true });
    await this.refreshLocalPluginInventory(replacement.client);
    if (profileId === DEFAULT_PROFILE_ID) {
      this.syncDefaultProfileHost(runtime, profileId, replacement, profileRuntime.session);
      await this.store.markConnected(runtime.hostId, {
        instanceId: replacement.instanceId,
        version: replacement.version,
        buildId: replacement.buildId,
      });
      if (runtime.phase !== 'connected' && runtime.phase !== 'failed') this.transition(runtime, 'connected');
    }
    return replacement;
  }

  async ensureTransport(session, options = {}) {
    if (session.connected) return session;
    if (session.operation) return session.operation;
    const record = this.store.require(session.hostId);
    const preferredVersion = await this.localVersion();
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
      return await promise;
    } finally {
      if (session.operation === promise) session.operation = null;
      session.abort = null;
    }
  }

  async openSessionTransport(session, record, options) {
    const { version, interactive, background, signal } = options;
    if (this.transport !== 'guest') {
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
      latestDshVersion: runtime.latestDshVersion ?? null,
      upgrade: this.upgradeSnapshot(runtime),
      pluginAlignment: publicPluginAlignment(runtime.pluginAlignment),
      connected: Boolean(session?.connected),
      error: runtime.error ?? null,
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
    const runtimes = this.store.list().map((record) => this.runtime(record.id));
    await Promise.all(runtimes.map((runtime) => this.refreshLatestDshVersion(runtime)));
    for (const runtime of runtimes) this.prepareUpgradeReport(runtime);
    const connections = runtimes.map((runtime) => this.publicConnection(runtime.hostId));
    for (const runtime of runtimes) this.finishUpgradeReport(runtime);
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
  async performGuestConnect(runtime, { signal, background = false } = {}) {
    this.transition(runtime, 'installing');
    try {
      const session = await this.ensureProfileTransport(runtime.hostId, { background });
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
      state: 'running',
      phase: 'running',
      health: { healthy: true, connected: true, hostAlive: true, supervisorAlive: false },
      views: 0,
      dshVersion: card.guestVersion ?? null,
      connected: true,
    }));
  }

  async performConnect(runtime, options) {
    if (this.transport === 'guest') return this.performGuestConnect(runtime, options);

    const { signal, background } = options;
    const profileId = normalizeProfileId(options.profileId);
    const record = this.store.require(runtime.hostId);
    // The local Desktop DSH version only orders catalog preferences. The
    // remote runtime version comes from the runtime package bundled with this
    // plugin, so a local version change does not force a remote upgrade.
    const preferredVersion = await this.localVersion();

    // A Host this manager already holds is reused only when it runs the runtime
    // package this manager installed. A Host of another runtime is a separate
    // instance owned by another Desktop and is never stopped here.
    const active = runtime.host && !runtime.host.closed && runtime.phase === 'connected' ? runtime.host : null;
    const sessionConnected = this.sessions.get(runtime.hostId)?.connected === true;
    // Only a held Host or an open transport can change which runtime this
    // manager should use; the first connection lets the session select it.
    const expectedArtifact = active || sessionConnected ? await this.selectExpectedArtifact(runtime, preferredVersion) : null;
    const activeArtifact = expectedArtifact ?? runtime.artifact ?? this.sessions.get(runtime.hostId)?.artifact ?? null;
    if (active) {
      const reusable = Boolean(activeArtifact)
        && active.version === activeArtifact.dshVersion
        && active.buildId === activeArtifact.buildId
        && (!active.runtimeId || active.runtimeId === activeArtifact.runtimeId)
        && this.sessions.get(runtime.hostId)?.connected;
      if (reusable) {
        this.transition(runtime, 'switching');
        this.transition(runtime, 'connected');
        return browserResult(this, runtime);
      }
    }

    this.transition(runtime, 'installing');
    let session;
    let opened;
    let selectedArtifact;
    let detached = false;
    try {
      const shared = this.session(runtime.hostId);
      // Reopening the controller on the existing channel installs the bundled
      // runtime before any Host is stopped and keeps other profile Hosts on
      // this SSH connection online.
      if (!shared.connected || (expectedArtifact && shared.artifact?.runtimeId !== expectedArtifact.runtimeId)) {
        session = await this.openControllerSession({
          ...shared.connected ? { channel: shared.channel } : {},
          alias: record.hostAlias,
          catalog: this.catalog,
          version: preferredVersion,
          signal,
          interactive: !background,
          background,
          authCallbacks: authenticationCallbacks(this.interactions, runtime.hostId),
          hostKeyVerifier: interactiveHostKeyVerifier(this.interactions, runtime.hostId),
        });
        shared.attachTransport(session);
      }
      session = {
        channel: shared.channel,
        controller: shared.controller,
        installed: shared.installed,
        artifact: shared.artifact,
        target: shared.target,
      };
      signal.throwIfAborted();
      selectedArtifact = session.artifact;
      if (!selectedArtifact?.dshVersion) throw error('REMOTE_INSTALL_FAILED', 'The remote runtime package is unavailable.');
      const targetVersion = selectedArtifact.dshVersion;
      const targetVersionChanged = Boolean(record.lastServerVersion && record.lastServerVersion !== targetVersion);
      if (targetVersionChanged) this.transition(runtime, 'upgrading');
      // The list is scoped to this manager's runtime identity. Instances of
      // another runtime package are separate instances and stay untouched.
      const listed = await session.controller.list({ version: targetVersion, buildId: selectedArtifact.buildId, profileId });
      signal.throwIfAborted();
      const savedId = options.reconnectInstanceId ?? record.lastInstanceId;
      const previous = listed.instances.find((entry) => entry.instance?.instanceId === savedId
        && matchesProfile(entry, profileId));
      const exact = previous?.instance?.dshVersion === targetVersion
        && previous?.instance?.buildId === selectedArtifact.buildId
        && instanceRuntimeMatches(previous?.instance, selectedArtifact.runtimeId);

      // The matching runtime is installed: only now detach this manager's own
      // previous Host. Its remote instance keeps running for other clients and
      // expires by its idle timeout.
      if (active) {
        await this.detachActiveHost(runtime, active);
        detached = true;
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
          artifactPath: selectedArtifact.artifactPath,
          sha256: selectedArtifact.sha256,
          version: targetVersion,
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
      signal.throwIfAborted();

      runtime.pluginAlignment = await this.alignRemotePlugins(runtime, { profileId });
      signal.throwIfAborted();
      if (!runtime.host) {
        // Plugin alignment can restart the Host; a failed restart leaves no
        // instance to report as connected.
        throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The remote Host is unavailable after plugin alignment.', {
          pluginAlignment: publicPluginAlignment(runtime.pluginAlignment),
        });
      }

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
        version: targetVersion,
        buildId: runtime.artifact.buildId,
      });
      runtime.reconnectAttempts = 0;
      this.adoptDefaultWebHost(runtime, profileId);
      this.transition(runtime, 'ready');
      this.transition(runtime, 'switching');
      this.transition(runtime, 'connected');
      const alignment = publicPluginAlignment(runtime.pluginAlignment);
      // The remote "local plugins" list lives in Host memory; a reused or
      // restarted Host starts empty, so send the snapshot on every connect.
      if (runtime.host?.client) await this.refreshLocalPluginInventory(runtime.host.client);
      return {
        ...browserResult(this, runtime, sync),
        ...alignment ? { pluginAlignment: alignment } : {},
        host: { ...this.publicConnection(runtime.hostId), ...connected, phase: 'connected' },
      };
    } catch (cause) {
      this.interactions.cancelHost(runtime.hostId);
      if (active && runtime.host === active && !active.closed && !detached) {
        // The matching runtime could not be installed: keep the working Host
        // and its shared transport.
        this.transition(runtime, 'connected', cause);
      } else {
        if (runtime.host) await this.releaseRuntime(runtime);
        this.transition(runtime, 'failed', cause);
      }
      throw cause;
    }
  }
  async detachActiveHost(runtime, host) {
    this.closingHosts.add(host);
    await host.close().catch(() => {});
    for (const profileRuntime of this.profileRuntimes(runtime.hostId).values()) {
      if (profileRuntime.host !== host) continue;
      profileRuntime.host = null;
      profileRuntime.instanceId = null;
      if (profileRuntime.phase === 'running') profileRuntime.phase = 'idle';
    }
    if (runtime.host === host) {
      runtime.host = null;
      runtime.error = null;
    }
    this.publish(runtime.hostId);
  }

  async selectExpectedArtifact(runtime, preferredVersion) {
    const target = runtime.target ?? runtime.artifact?.target ?? this.sessions.get(runtime.hostId)?.target;
    if (!target) return null;
    try {
      return await this.catalog.select({ version: preferredVersion, target });
    } catch {
      return null;
    }
  }

  async alignRemotePlugins(runtime, { profileId = DEFAULT_PROFILE_ID } = {}) {
    const host = runtime.host;
    if (!host || host.closed || !host.client) return null;
    try {
      const localBundles = await this.localBundles();
      // Without a local inventory there is no target version to align to, and
      // the connection must not pay for a remote backup or an extra call.
      if (!Array.isArray(localBundles) || localBundles.length === 0) return null;
      const listed = await host.client.post('/api/ssh-remote/plugins/list', {});
      const plan = buildPluginAlignmentPlan({
        localBundles,
        remoteBundles: Array.isArray(listed?.bundles) ? listed.bundles : [],
        profileId,
      });
      if (plan.operations.length === 0) return null;

      const backup = await this.createRemoteBackup(host.client, profileId);
      const items = [];
      let restartRequired = false;
      for (const operation of plan.operations) {
        const item = {
          name: operation.name,
          fromVersion: operation.remoteVersion,
          toVersion: operation.toVersion,
        };
        try {
          // Re-read the Host on every step: remote plugin actions can apply
          // through HMR and briefly invalidate the previous client.
          const client = runtime.host?.client;
          if (!client) throw error('REMOTE_PLUGIN_ALIGNMENT_FAILED', 'The remote Host is no longer connected.');
          const removed = await client.post('/api/ssh-remote/plugins/remove', { name: operation.name });
          if (removed?.ok === false) {
            throw error('REMOTE_PLUGIN_ALIGNMENT_FAILED', 'The remote plugin could not be removed.', {
              remote: removed?.result?.error?.code ?? null,
            });
          }
          const installed = await client.post('/api/ssh-remote/plugins/install', {
            spec: operation.spec,
            requestId: randomUUID(),
          });
          const result = installed?.result ?? {};
          if (installed?.ok === false || result.application === 'failed' || result.application === 'cancelled') {
            throw error('REMOTE_PLUGIN_ALIGNMENT_FAILED', 'The remote plugin installation failed.', {
              remote: result.error?.code ?? null,
            });
          }
          const pendingBuilds = (Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [])
            .filter((value) => typeof value === 'string' && value.length > 0).slice(0, 16);
          if (pendingBuilds.length > 0) {
            // Build scripts need explicit approval and the plugin stays absent;
            // report it without retrying or rolling back the removal.
            items.push({
              ...item,
              ok: false,
              error: { code: 'PLUGIN_BUILD_APPROVAL_REQUIRED', message: 'The remote plugin build scripts need approval before it can be installed.' },
              pendingBuilds,
            });
            continue;
          }
          // Only a restart-required application needs the Host replaced; HMR
          // (`applied`) takes effect without touching it.
          if (result.application === 'restart-required') restartRequired = true;
          items.push({
            ...item,
            ok: true,
            application: typeof result.application === 'string' ? result.application.slice(0, 64) : 'applied',
          });
        } catch (cause) {
          // A single plugin failure is recorded and the rest continue.
          items.push({ ...item, ok: false, error: publicError(cause) });
        }
      }
      let restarted = false;
      let restartError = null;
      if (restartRequired && items.some((item) => item.ok)) {
        try {
          await this.restartHostAfterPluginAlignment(runtime);
          restarted = true;
        } catch (cause) {
          restartError = publicError(cause);
        }
      }
      return {
        ok: items.every((item) => item.ok) && !restartError,
        items,
        skipped: plan.skipped,
        restarted,
        backup,
        ...restartError ? { error: restartError } : {},
      };
    } catch (cause) {
      return {
        ok: false,
        items: [],
        skipped: [],
        restarted: false,
        backup: null,
        error: publicError(cause),
      };
    }
  }

  async restartHostAfterPluginAlignment(runtime) {
    const host = runtime.host;
    if (!host || host.closed) throw error('REMOTE_INSTANCE_UNAVAILABLE', 'The remote Host is not connected.');
    if (runtime.profileId !== undefined) return this.restartProfileHost(runtime, host);
    return this.restartConnectedHost(runtime, host);
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
      runtimeId: session.artifact.runtimeId,
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
    return this.restartHost(runtime, originalHost);
  }

  async restartProfileHost(runtime, originalHost) {
    return this.restartHost(runtime, originalHost, { profile: true });
  }

  /**
   * Stops one remote Host and opens a replacement on the same shared channel
   * and controller. Profile Hosts use the profile runtime bookkeeping; the
   * default Web Host also updates the stored connection record.
   */
  async restartHost(runtime, originalHost, { profile = false } = {}) {
    const oldInstanceId = originalHost.instanceId;
    // A Host attached to a saved instance wraps the shared controller in a
    // one-instance adapter; restarting must use the real controller so the
    // replacement can look up and start its own instance.
    const controller = runtime.controller ?? runtime.session?.controller ?? originalHost.controller;
    this.closingHosts.add(originalHost);
    await originalHost.close();
    await controller.stop({ instanceId: oldInstanceId });
    const replacement = new this.RemoteHostConnection({
      channel: originalHost.channel,
      controller,
      version: originalHost.version,
      buildId: originalHost.buildId,
      runtimeId: originalHost.runtimeId,
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
      if (profile) {
        runtime.instanceId = replacement.instanceId;
        if (runtime.phase !== 'failed') runtime.phase = 'running';
        runtime.error = null;
        this.observeProfileHost(runtime, replacement);
        this.publish(runtime.hostId);
      } else {
        runtime.channel = replacement.channel;
        runtime.controller = replacement.controller;
        this.observeHost(runtime, replacement);
        await this.store.markConnected(runtime.hostId, {
          instanceId: replacement.instanceId,
          version: replacement.version,
          buildId: replacement.buildId,
        });
      }
      return replacement;
    } catch (cause) {
      await replacement.close().catch(() => {});
      runtime.host = null;
      if (profile) {
        runtime.phase = 'failed';
        runtime.error = publicError(cause);
        this.publish(runtime.hostId);
      } else {
        this.transition(runtime, 'failed', cause);
      }
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
    // Plugin configuration follows the plugins both sides share: entries and
    // settings are pushed for those, unrelated local configuration stays local.
    let pluginConfig = null;
    try {
      const shared = await this.sharedPluginNames({ host: runtime.host });
      if (shared.size > 0) pluginConfig = await this.syncPluginConfig(runtime, { host: runtime.host }, { names: shared });
      if (pluginConfig?.entries?.restartRequired === true) {
        const oldInstanceId = runtime.host.instanceId;
        const replacement = await this.restartConnectedHost(runtime, runtime.host);
        report = { ...report, restarted: true, previousInstanceId: oldInstanceId, instanceId: replacement.instanceId };
        pluginConfig = { ...pluginConfig, restarted: true };
      }
    } catch (cause) {
      pluginConfig = { ok: false, error: publicError(cause) };
    }
    report = {
      ...report,
      ok: report.ok && sharingSucceeded(pluginSharing),
      pluginSharing,
      ...pluginConfig ? { pluginConfig } : {},
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
