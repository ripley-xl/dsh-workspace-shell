import { randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readTuiDeclaration, tuiAdapter, tuiEnvironment, tuiPackageName } from './tui-adapters.js';
import { parseCommandLine } from './command-line.js';
import { isNewerVersion } from './registry.js';
import { listHostCards } from './host-discovery.js';

const WEB_BUNDLE = '@deepseek-ai/dsh-web-app';
const requireGuest = createRequire(import.meta.url);
// The guest Host package provides the profile patch every Web Guest runs. A
// profile that cannot resolve it still starts; its Guest pages simply lack the
// guest Client.
const WEB_CWD_PATCH = (() => {
  try {
    const manifest = requireGuest.resolve('dsh-workspace-guest/package.json');
    return path.join(path.dirname(manifest), 'cordis.patch.yml');
  } catch {
    return null;
  }
})();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_VERSION_BYTES = 64 * 1024;
const MAX_WEB_LINE_BYTES = 64 * 1024;
const MAX_TERMINAL_WRITE_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_BYTES = 1024 * 1024;
const MAX_RETAINED_RUNTIMES = 128;
const MAX_ACTIVE_RUNTIMES = 16;
// A Web Host that restarts itself disappears for a moment; the record waits for
// the replacement's card before it settles on `exited`.
const RESTART_POLL_MS = 500;
const RESTART_WAIT_MS = 20_000;
const ACTIVE_PHASES = new Set(['starting', 'running', 'stopping', 'restarting']);
// Catalog ids for Hosts discovered through their card rather than spawned here.
const DISCOVERED_PREFIX = 'host:';

const ERRORS = {
  INVALID_INPUT: 'The request is invalid.',
  PROFILE_NOT_FOUND: 'The requested profile is unavailable.',
  CURRENT_PROFILE_USE_LOCAL: 'Use the current local workspace directly.',
  INDEPENDENT_HOST_CONFIRMATION_REQUIRED: 'Confirm that no independent Host is running for this profile.',
  PROFILE_HOST_CONFLICT: 'Another managed Host is already active for this profile.',
  RUNTIME_NOT_FOUND: 'The requested runtime does not exist.',
  RUNTIME_OWNER_MISMATCH: 'Only the runtime owner may perform this operation.',
  RUNTIME_NOT_ACTIVE: 'The runtime is not active.',
  CLI_VERSION_CHECK_FAILED: 'The CLI version check failed.',
  WEB_STARTUP_FAILED: 'The Web Host did not provide a valid loopback URL.',
  TUI_NOT_INSTALLED: 'The TUI package is not installed for this profile.',
  TUI_PROFILE_CONFLICT: 'The profile declares more than one terminal UI.',
  OPERATION_CANCELLED: 'The operation was cancelled.',
  STARTUP_TIMEOUT: 'The runtime startup timed out.',
  SERVICE_DISPOSED: 'The runtime service is disposed.',
  RUNTIME_STOP_FAILED: 'The runtime did not exit cleanly.',
  RUNTIME_ID_CONFLICT: 'The runtime identifier is already in use.',
  RUNTIME_LIMIT_REACHED: 'Too many active runtimes.',
  PROFILE_CANDIDATE_INVALID: 'An invalid profile candidate was ignored.',
  UPGRADE_BUSY: 'Another upgrade is already running for this Host.',
  UPGRADE_UNSUPPORTED_PROFILE: 'This profile is not supported for the local upgrade.',
  UPGRADE_PROFILE_UNAVAILABLE: 'The profile directory is unavailable.',
  UPGRADE_REGISTRY_UNAVAILABLE: 'The npm registry is unavailable.',
  UPGRADE_NPM_FAILED: 'The global DSH installation failed.',
  UPGRADE_INSTALL_FAILED: 'The plugin install failed.',
  UPGRADE_VALIDATION_FAILED: 'The profile configuration could not be validated.',
  UPGRADE_BACKUP_FAILED: 'The profile files could not be backed up.',
  UPGRADE_RESTORE_FAILED: 'The profile files could not be restored.',
  UPGRADE_RUNTIME_UNAVAILABLE: 'The running Host could not be stopped.',
  UPGRADE_PLUGIN_FAILED: 'A plugin could not be installed.',
};

const CLI_VERSION_OUTPUT = /^[vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DEFAULT_VERSION_CHECK_TTL_MS = 10 * 60 * 1000;

function failure(code) {
  const error = new Error(ERRORS[code] ?? ERRORS.INVALID_INPUT);
  error.code = code;
  error.safe = true;
  return error;
}

function safe(error, fallback = 'INVALID_INPUT') {
  return error?.safe === true ? error : failure(fallback);
}

function abortError() {
  return failure('OPERATION_CANCELLED');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value === '.' || value === '..') {
    throw failure(label === 'profile' ? 'PROFILE_NOT_FOUND' : 'INVALID_INPUT');
  }
  return value;
}

function absolute(value, label = 'INVALID_INPUT') {
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/u.test(value) || !path.isAbsolute(value)) {
    throw failure(label);
  }
  return value;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 500) {
    throw failure('INVALID_INPUT');
  }
  return { cols, rows };
}

function bundleSpecName(value) {
  if (typeof value !== 'string') return null;
  if (value === WEB_BUNDLE || value.startsWith(`${WEB_BUNDLE}@`)) return WEB_BUNDLE;
  return tuiPackageName(value);
}

function candidates(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  const values = Array.isArray(declared) ? declared : declared && typeof declared === 'object' ? Object.keys(declared) : [];
  const names = new Set();
  for (const value of values) {
    const name = bundleSpecName(typeof value === 'string' ? value : value?.name ?? value?.package ?? value?.spec);
    if (name) names.add(name);
  }
  return { web: names.has(WEB_BUNDLE), ...readTuiDeclaration(manifest) };
}

function publicExit(outcome) {
  return {
    exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
    signal: typeof outcome?.signal === 'string' ? outcome.signal : null,
  };
}

async function ignoreStream(stream) {
  if (!stream) return;
  try {
    for await (const _ of stream) void _;
  } catch {
    // Process output is private and is never returned or logged.
  }
}

async function collectText(stream, maxBytes, code) {
  if (!stream) return '';
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw failure(code);
    text += decoder.write(buffer);
  }
  text += decoder.end();
  return text;
}

function webEnvironment(home, hostKey) {
  const env = {
    DSH_HOME: home,
    // Binds the Host card this process publishes to the exact Shell record.
    DSH_WORKSPACE_HOST_KEY: hostKey,
    DSH_TUI_BACKEND: undefined,
    DSH_TUI_WORKSPACE_TARGET: undefined,
    DSH_TUI_DISABLE_TERMINAL_IMAGES: undefined,
    DSH_TUI_DISABLE_EXTENDED_KEYS: undefined,
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DSH_TUI_')) env[key] = undefined;
  }
  return env;
}

function validateWebUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure('WEB_STARTUP_FAILED');
  }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
    || !url.port || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw failure('WEB_STARTUP_FAILED');
  }
  return url.href;
}

function notify(record) {
  const event = { runtimeId: record.id, firstSeq: record.firstSeq, nextSeq: record.nextSeq, phase: record.phase };
  for (const listener of [...record.listeners]) {
    try {
      listener(event);
    } catch {
      // Observers cannot break terminal cleanup or other listeners.
    }
  }
}

function trimTerminalStart(value, maxBytes) {
  let index = 0;
  let bytes = 0;
  while (index < value.length && bytes < maxBytes) {
    const character = String.fromCodePoint(value.codePointAt(index));
    bytes += Buffer.byteLength(character, 'utf8');
    index += character.length;
  }
  const data = value.slice(index);
  return { data, removedBytes: Buffer.byteLength(value, 'utf8') - Buffer.byteLength(data, 'utf8') };
}

function appendTerminal(record, data) {
  if (!data) return;
  let part = '';
  let bytes = 0;
  const flush = () => {
    if (!part) return;
    const chunkBytes = Buffer.byteLength(part, 'utf8');
    record.chunks.push({ seq: ++record.nextSeq, data: part, bytes: chunkBytes });
    record.bytes += chunkBytes;
    part = '';
    bytes = 0;
  };
  for (const character of data) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 64 * 1024) flush();
    part += character;
    bytes += size;
  }
  flush();
  while (record.chunks.length && record.bytes > record.maxBytes) {
    const excess = record.bytes - record.maxBytes;
    const first = record.chunks[0];
    if (first.bytes <= excess) {
      record.chunks.shift();
      record.bytes -= first.bytes;
      record.truncatedFirstSeq = null;
    } else {
      const trimmed = trimTerminalStart(first.data, excess);
      first.data = trimmed.data;
      first.bytes -= trimmed.removedBytes;
      record.bytes -= trimmed.removedBytes;
      record.truncatedFirstSeq = first.seq;
    }
    record.firstSeq = record.chunks[0]?.seq ?? record.nextSeq + 1;
  }
  notify(record);
}

async function consumeTerminal(record, stream) {
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      appendTerminal(record, decoder.write(buffer));
    }
    appendTerminal(record, decoder.end());
  } catch {
    // The exit metadata remains available without exposing stream errors.
  }
}

export function createLocalRuntimeService(options) {
  const subprocess = options?.subprocess;
  const profileContext = options?.profileContext;
  const currentDshVersion = options?.currentDshVersion;
  const upgrades = options?.upgrades;
  const versionCheckTtlMs = options?.versionCheckTtlMs ?? DEFAULT_VERSION_CHECK_TTL_MS;
  const expectedTuiVersion = options?.expectedTuiVersion ?? '0.18.0';
  const expectedPiTuiVersion = options?.expectedPiTuiVersion ?? '0.5.5';
  const cliCommand = options?.cliCommand ?? 'dsh';
  const startupTimeoutMs = options?.startupTimeoutMs ?? 30_000;
  const graceMs = options?.graceMs ?? 8_000;
  const terminalBytes = options?.terminalBytes ?? DEFAULT_TERMINAL_BYTES;
  // Host discovery is injected so tests can supply cards without touching
  // `<DSH_HOME>/workspace-hosts`.
  const hostDiscovery = options?.hostDiscovery ?? { listHostCards };
  const restartPollMs = options?.restartPollMs ?? RESTART_POLL_MS;
  const restartWaitMs = options?.restartWaitMs ?? RESTART_WAIT_MS;
  const fs = {
    readdir: options?.fs?.readdir ?? nodeFs.readdir,
    readFile: options?.fs?.readFile ?? nodeFs.readFile,
    realpath: options?.fs?.realpath ?? nodeFs.realpath,
    stat: options?.fs?.stat ?? nodeFs.stat,
    lstat: options?.fs?.lstat ?? nodeFs.lstat,
  };
  const timers = {
    setTimeout: options?.timers?.setTimeout ?? setTimeout,
    clearTimeout: options?.timers?.clearTimeout ?? clearTimeout,
  };
  const makeId = options?.idFactory ?? randomUUID;
  if (!subprocess || !profileContext || typeof expectedTuiVersion !== 'string' || !expectedTuiVersion
    || typeof expectedPiTuiVersion !== 'string' || !expectedPiTuiVersion) throw failure('INVALID_INPUT');
  if (currentDshVersion !== undefined && typeof currentDshVersion !== 'string' && typeof currentDshVersion !== 'function') {
    throw failure('INVALID_INPUT');
  }
  if (upgrades !== undefined && (typeof upgrades?.check !== 'function' || typeof upgrades?.start !== 'function'
    || typeof upgrades?.state !== 'function')) throw failure('INVALID_INPUT');
  if (typeof hostDiscovery?.listHostCards !== 'function') throw failure('INVALID_INPUT');
  absolute(profileContext.dir);
  absolute(profileContext.home);
  absolute(profileContext.cwd);
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || !Number.isInteger(graceMs) || graceMs < 1
    || !Number.isInteger(terminalBytes) || terminalBytes < 1
    || !Number.isInteger(restartPollMs) || restartPollMs < 1
    || !Number.isInteger(restartWaitMs) || restartWaitMs < 1
    || !Number.isInteger(versionCheckTtlMs) || versionCheckTtlMs < 0) throw failure('INVALID_INPUT');

  const profilesHome = path.resolve(profileContext.home);
  const currentDirectory = path.resolve(profileContext.dir);
  const profilesRoot = path.join(profilesHome, 'profiles');
  const records = new Map();
  let disposed = false;
  let disposePromise = null;
  let versionPromise = null;
  let versionController = null;
  let cwdPromise = null;
  const checks = new Map();
  let currentVersionCache = { at: 0, value: null };
  const suppressedUpgrades = new Set();

  async function realDirectory(value) {
    const directory = await fs.realpath(value);
    const info = await fs.stat(directory);
    if (!info.isDirectory()) throw failure('INVALID_INPUT');
    return directory;
  }

  async function verifiedCwd() {
    cwdPromise ??= realDirectory(profileContext.cwd);
    return cwdPromise;
  }

  async function readPackage(directory) {
    const root = await realDirectory(directory);
    const manifestPath = await fs.realpath(path.join(root, 'package.json'));
    if (!contained(root, manifestPath)) throw failure('PROFILE_NOT_FOUND');
    const info = await fs.stat(manifestPath);
    if (!info.isFile() || info.size > MAX_PACKAGE_BYTES) throw failure('PROFILE_NOT_FOUND');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw failure('PROFILE_NOT_FOUND');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('PROFILE_NOT_FOUND');
    return { root, manifest, manifestPath };
  }

  async function loadProfile(profileId, { allowCurrent = false } = {}) {
    identifier(profileId, 'profile');
    try {
      const root = await realDirectory(profilesRoot);
      const candidate = path.join(root, profileId);
      const candidateInfo = await fs.lstat(candidate);
      if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) throw failure('PROFILE_NOT_FOUND');
      const directory = await fs.realpath(candidate);
      if (!contained(root, directory)) throw failure('PROFILE_NOT_FOUND');
      const { root: profileDir, manifest } = await readPackage(directory);
      if (!contained(root, profileDir)) throw failure('PROFILE_NOT_FOUND');
      if (!allowCurrent && (profileId === profileContext.name || profileDir === await realDirectory(currentDirectory))) {
        throw failure('CURRENT_PROFILE_USE_LOCAL');
      }
      return { id: profileId, dir: profileDir, manifest, ...candidates(manifest) };
    } catch (error) {
      if (error?.code === 'CURRENT_PROFILE_USE_LOCAL') throw error;
      throw safe(error, 'PROFILE_NOT_FOUND');
    }
  }

  async function verifyTui(profile) {
    try {
      const adapter = tuiAdapter(profile.tuiFlavor);
      if (!adapter) throw failure(profile.tuiConflict ? 'TUI_PROFILE_CONFLICT' : 'TUI_NOT_INSTALLED');
      if (adapter.packageName === null) return;
      const expectedVersion = adapter.flavor === 'dsh-tui' ? expectedTuiVersion : expectedPiTuiVersion;
      const packagePath = await fs.realpath(path.join(profile.dir, 'node_modules', ...adapter.packageName.split('/'), 'package.json'));
      const info = await fs.stat(packagePath);
      if (!info.isFile() || info.size > MAX_PACKAGE_BYTES) throw failure('TUI_NOT_INSTALLED');
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      } catch {
        throw failure('TUI_NOT_INSTALLED');
      }
      if (manifest?.name !== adapter.packageName || manifest?.version !== expectedVersion) throw failure('TUI_NOT_INSTALLED');
    } catch (error) {
      throw safe(error, 'TUI_NOT_INSTALLED');
    }
  }

  function parseCliVersion(stdout) {
    const first = String(stdout ?? '').trim().split(/\r?\n/u)[0]?.trim() ?? '';
    return CLI_VERSION_OUTPUT.test(first) ? first : null;
  }

  // The CLI version is recorded for the Host row; it is no longer a startup
  // gate, because the profile-based CLI may legitimately differ from the
  // version this plugin was authored against.
  async function probeVersion() {
    if (!versionPromise) {
      versionController = new AbortController();
      const signal = versionController.signal;
      versionPromise = (async () => {
        let timer;
        try {
          timer = timers.setTimeout(() => versionController?.abort(), startupTimeoutMs);
          timer.unref?.();
          const executable = await subprocess.resolveExecutable(cliCommand, undefined, signal);
          let version = null;
          try {
            const handle = subprocess.spawn({
              argv: [executable, '--version'],
              cwd: await verifiedCwd(),
              stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
              graceMs,
              env: { DSH_HOME: profilesHome },
              signal,
            });
            try {
              const [stdout, outcome] = await Promise.all([
                collectText(handle.stdout, MAX_VERSION_BYTES, 'CLI_VERSION_CHECK_FAILED'),
                handle.done,
                ignoreStream(handle.stderr),
              ]);
              if (outcome?.exitCode === 0) version = parseCliVersion(stdout);
            } catch {
              try { handle.terminate(); } catch { /* already gone */ }
              await Promise.resolve(handle.waitForExit?.()).catch(() => false);
            }
          } catch {
            // A failed version probe only hides the version; spawning the Host
            // reports its own error if the executable cannot run at all.
            version = null;
          }
          return { executable, version };
        } finally {
          timers.clearTimeout(timer);
        }
      })();
      versionPromise.catch(() => { versionPromise = null; });
    }
    return versionPromise;
  }

  async function waitForVersion(signal) {
    let rejectCancel;
    const cancelled = new Promise((resolve, reject) => {
      rejectCancel = reject;
    });
    const onAbort = () => rejectCancel(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfAborted(signal);
      return await Promise.race([probeVersion(), cancelled]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function upgradeCode(error, fallback = 'UPGRADE_PROFILE_UNAVAILABLE') {
    return error?.safe === true && typeof error.code === 'string' && Object.hasOwn(ERRORS, error.code) ? error.code : fallback;
  }

  async function currentVersion() {
    if (typeof currentDshVersion === 'string') return currentDshVersion || null;
    if (typeof currentDshVersion !== 'function') return null;
    const nowMs = Date.now();
    if (currentVersionCache.at && nowMs - currentVersionCache.at < 60_000) return currentVersionCache.value;
    let value = null;
    try {
      const result = await currentDshVersion();
      if (typeof result === 'string' && result) value = result;
    } catch {
      value = null;
    }
    currentVersionCache = { at: nowMs, value };
    return value;
  }

  // Version and alignment probes are Host-side and cached; `catalog` only
  // reads them and triggers one refresh when the cache is empty or stale.
  function checkEntry(profileId, version) {
    if (!upgrades) return null;
    const key = `${profileId}\u0000${version ?? ''}`;
    const cached = checks.get(key);
    const nowMs = Date.now();
    if (cached && (cached.checking || nowMs - cached.at < versionCheckTtlMs)) return cached;
    const entry = {
      at: nowMs,
      checking: true,
      latestDshVersion: cached?.latestDshVersion ?? null,
      alignPending: cached?.alignPending ?? null,
      dshUpgradeAllowed: cached?.dshUpgradeAllowed !== false,
      error: null,
      pending: null,
    };
    checks.set(key, entry);
    entry.pending = (async () => {
      try {
        const result = await upgrades.check({ profileId, dshVersion: version });
        entry.latestDshVersion = typeof result?.latestDshVersion === 'string' ? result.latestDshVersion : null;
        entry.alignPending = typeof result?.alignPending === 'boolean' ? result.alignPending : null;
        entry.dshUpgradeAllowed = result?.dshUpgradeAllowed !== false;
        entry.error = typeof result?.error === 'string' ? result.error : null;
      } catch (error) {
        entry.error = upgradeCode(error);
      } finally {
        entry.at = Date.now();
        entry.checking = false;
        entry.pending = null;
      }
    })();
    return entry;
  }

  function invalidateChecks(profileId) {
    for (const key of [...checks.keys()]) {
      if (key.startsWith(`${profileId}\u0000`)) checks.delete(key);
    }
  }

  function upgradeFields(profileId, version, runtimeId, { probe = true } = {}) {
    const entry = upgrades && probe ? checkEntry(profileId, version) : null;
    const upgrade = upgrades ? upgrades.state({ profileId, runtimeId: runtimeId ?? null }) : null;
    if (upgrade?.phase === 'done' && (runtimeId === null || runtimeId === undefined)) {
      // The current Host keeps running the code it booted with; other profiles
      // are not running yet, so a fresh CLI probe is enough to clear the row.
      if (profileId === profileContext.name) suppressedUpgrades.add(profileId);
      else versionPromise = null;
    }
    if (upgrade?.phase === 'done' || upgrade?.phase === 'failed') invalidateChecks(profileId);
    const known = typeof version === 'string' && version !== '';
    const checking = entry?.checking === true;
    const newer = known && entry?.dshUpgradeAllowed !== false && isNewerVersion(entry?.latestDshVersion, version);
    const alignPending = profileId === 'web' && entry?.alignPending === true;
    const running = upgrade?.phase === 'running';
    const upgradeAvailable = Boolean(upgrades) && known && !checking && !running
      && !(runtimeId === null || runtimeId === undefined ? suppressedUpgrades.has(profileId) : false)
      && (newer || alignPending);
    return {
      dshVersion: known ? version : null,
      latestDshVersion: typeof entry?.latestDshVersion === 'string' ? entry.latestDshVersion : null,
      checking,
      ...(profileId === 'web' ? { alignPending: typeof entry?.alignPending === 'boolean' ? entry.alignPending : null } : {}),
      upgradeAvailable,
      ...(upgrade ? { upgrade } : {}),
    };
  }

  function runtimeById(runtimeId, ownerId, { active = false, kind } = {}) {
    // Discovered Hosts are addressed by their card, never by this service's
    // owned records; they can be attached but not stopped or upgraded.
    if (typeof runtimeId === 'string' && runtimeId.startsWith(DISCOVERED_PREFIX)) throw failure('RUNTIME_NOT_FOUND');
    identifier(runtimeId, 'runtime');
    identifier(ownerId, 'owner');
    const record = records.get(runtimeId);
    if (!record) throw failure('RUNTIME_NOT_FOUND');
    if (record.ownerId !== ownerId) throw failure('RUNTIME_OWNER_MISMATCH');
    if (kind && record.kind !== kind) throw failure('RUNTIME_NOT_FOUND');
    if (active && record.phase !== 'running') throw failure('RUNTIME_NOT_ACTIVE');
    return record;
  }

  function pruneRecords() {
    if (records.size <= MAX_RETAINED_RUNTIMES) return;
    for (const [id, record] of records) {
      if (records.size <= MAX_RETAINED_RUNTIMES) break;
      if (!ACTIVE_PHASES.has(record.phase)) records.delete(id);
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let timer;
      const wake = () => {
        signal?.removeEventListener('abort', wake);
        timers.clearTimeout(timer);
        resolve();
      };
      timer = timers.setTimeout(wake, ms);
      timer.unref?.();
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  function portOf(url) {
    try {
      const port = Number(new URL(url).port);
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  }

  async function replacementCard(record) {
    const listed = await hostDiscovery.listHostCards({ home: profilesHome });
    const hosts = Array.isArray(listed?.hosts) ? listed.hosts : [];
    return hosts.find((host) => host && host.hostKey === record.id
      && Number.isInteger(host.pid) && host.pid !== record.pid
      && typeof host.url === 'string') ?? null;
  }

  function adoptCard(record, card) {
    let url;
    try {
      url = validateWebUrl(card.url);
    } catch {
      return false;
    }
    record.pid = Number.isInteger(card.pid) ? card.pid : record.pid;
    record.port = Number.isInteger(card.port) ? card.port : portOf(url);
    record.url = url;
    record.phase = 'running';
    record.exit = undefined;
    record.adopted = true;
    // The replacement is not this process's child: there is no handle to
    // signal, so ending the record must never pretend to stop it.
    record.handle = null;
    notify(record);
    return true;
  }

  // An adopted Host has no child handle, so its exits are invisible to us. Its
  // card is the only source of truth for "is it still there, and on which
  // port": re-read it before answering, otherwise a second restart would leave
  // the Shell pointing at a URL that no longer exists.
  async function refreshAdopted(record) {
    if (record?.adopted !== true || !ACTIVE_PHASES.has(record.phase)) return;
    let listed;
    try { listed = await hostDiscovery.listHostCards({ home: profilesHome }); } catch { return; }
    const card = (Array.isArray(listed?.hosts) ? listed.hosts : [])
      .find((host) => host?.hostKey === record.id && Number.isInteger(host.pid) && host.pid !== record.pid);
    if (!card) return;
    adoptCard(record, card);
  }

  // The Host exited without being asked to. A Guest Host restarts itself and
  // republishes its card under the same host key; wait for that card before
  // settling on `exited`. The wait is abortable by stop and dispose.
  function restart(record) {
    const controller = new AbortController();
    record.restartController = controller;
    const task = (async () => {
      const deadline = Date.now() + restartWaitMs;
      try {
        for (;;) {
          if (controller.signal.aborted || disposed) return;
          const card = await replacementCard(record).catch(() => null);
          if (controller.signal.aborted || disposed) return;
          if (card) {
            if (adoptCard(record, card)) return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(restartPollMs, remaining), controller.signal);
        }
      } catch {
        // A discovery failure ends the wait; it must never surface as a crash.
      }
      if (controller.signal.aborted || disposed) return;
      record.phase = 'exited';
      notify(record);
      pruneRecords();
    })();
    record.restartTask = task.catch(() => null);
    // Announce only after the task is observable, so a listener that reacts to
    // `restarting` can already wait on it.
    record.phase = 'restarting';
    notify(record);
    return record.restartTask;
  }

  function watch(record) {
    const finish = async (outcome) => {
      record.doneObserved = true;
      record.exit = publicExit(outcome);
      if (record.kind === 'tui') await record.outputTask?.catch(() => null);
      // A running Web Host that disappears on its own may be restarting
      // itself; only an explicit stop is final.
      if (record.kind === 'web' && record.phase === 'running' && !disposed) {
        await restart(record);
        return;
      }
      if (record.phase !== 'stopping' || record.exitCheckObserved) record.phase = 'exited';
      notify(record);
      pruneRecords();
    };
    void record.handle.done.then(finish, () => finish(null)).catch(() => {});
  }

  async function terminateHandle(record) {
    if (!record.handle) return;
    record.termination ??= (async () => {
      if (record.kind === 'web') {
        record.handle.terminate();
        let exitCheckFailed = false;
        let exitCheckError;
        try {
          const exited = await record.handle.waitForExit();
          exitCheckFailed = exited === false;
          if (exitCheckFailed) exitCheckError = failure('RUNTIME_STOP_FAILED');
        } catch (error) {
          exitCheckFailed = true;
          exitCheckError = error;
        }
        record.exitCheckObserved = true;
        if (exitCheckFailed) {
          if (record.doneObserved) {
            record.phase = 'exited';
            notify(record);
            pruneRecords();
          }
          throw exitCheckError;
        }
      } else {
        await record.handle.terminate();
      }
      await record.handle.done.catch(() => null);
      if (record.kind === 'tui') await record.outputTask?.catch(() => null);
      record.exit = publicExit(await record.handle.done.catch(() => null));
      record.phase = 'exited';
      notify(record);
      pruneRecords();
    })();
    return record.termination;
  }

  async function stopRecord(record) {
    if (record.stopPromise) return record.stopPromise;
    // An adopted Host is not this process's child, and a restart wait has no
    // process left to signal: both only end the Shell record.
    const detachable = record.phase === 'restarting' || record.adopted === true;
    record.phase = 'stopping';
    record.restartController?.abort();
    notify(record);
    record.stopPromise = (async () => {
      record.startController?.abort();
      await record.startPromise?.catch(() => null);
      await record.restartTask?.catch(() => null);
      if (detachable) {
        record.handle = null;
        record.phase = 'exited';
      } else {
        await terminateHandle(record);
        if (!record.handle) record.phase = 'exited';
      }
      notify(record);
      pruneRecords();
    })();
    return record.stopPromise;
  }

  function webUrl(record, signal) {
    let resolveReady;
    let rejectReady;
    let settled = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const onAbort = () => fail(abortError());
    const succeed = (url) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolveReady(url);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      rejectReady(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const drain = (async () => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      try {
        for await (const chunk of record.handle.stdout) {
          const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (settled) {
            pending = '';
            continue;
          }
          pending += decoded;
          const lines = pending.split(/\r?\n/u);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (Buffer.byteLength(line, 'utf8') > MAX_WEB_LINE_BYTES) throw failure('WEB_STARTUP_FAILED');
            const match = /^dsh web: (\S+)$/u.exec(line);
            if (match) {
              succeed(validateWebUrl(match[1]));
              pending = '';
              break;
            }
          }
          if (!settled && Buffer.byteLength(pending, 'utf8') > MAX_WEB_LINE_BYTES) throw failure('WEB_STARTUP_FAILED');
          throwIfAborted(signal);
        }
        if (!settled) fail(failure('WEB_STARTUP_FAILED'));
      } catch (error) {
        fail(safe(error, 'WEB_STARTUP_FAILED'));
      }
    })();
    return { ready, drain };
  }

  // A profile that installs the guest package already loads its own bridge; the
  // boot patch is only the fallback for profiles that do not.
  async function profileHasGuest(profileId) {
    try {
      const profile = await loadProfile(profileId, { allowCurrent: true });
      const bundles = profile.manifest?.dsh?.profile?.bundles;
      return Array.isArray(bundles) && bundles.includes('dsh-workspace-guest');
    } catch {
      return false;
    }
  }

  async function startWeb(record, executable, signal) {
    const guestPatch = WEB_CWD_PATCH && !await profileHasGuest(record.profileId) ? ['--patch', WEB_CWD_PATCH] : [];
    record.handle = subprocess.spawn({
      argv: [executable, '--profile', record.profileId, ...guestPatch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      cwd: await verifiedCwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs,
      env: webEnvironment(profilesHome, record.id),
      signal,
    });
    watch(record);
    void ignoreStream(record.handle.stderr);
    const output = webUrl(record, signal);
    record.outputTask = output.drain;
    record.url = await output.ready;
    record.port = portOf(record.url);
    if (Number.isInteger(record.handle?.pid)) record.pid = record.handle.pid;
    return { runtimeId: record.id, url: record.url };
  }

  async function startTui(record, executable, cwd, signal, command) {
    const actualCwd = await realDirectory(cwd);
    let argv = [executable, '--profile', record.profileId];
    if (command !== undefined) {
      const parsed = parseCommandLine(command);
      const commandExecutable = await subprocess.resolveExecutable(parsed[0], undefined, signal);
      argv = [commandExecutable, ...parsed.slice(1)];
    }
    record.handle = await subprocess.spawnTerminal({
      argv,
      cwd: actualCwd,
      env: tuiEnvironment(record.tuiFlavor, { home: profilesHome, cwd: actualCwd }),
      cols: record.cols,
      rows: record.rows,
      terminalType: 'xterm-256color',
      graceMs,
      signal,
    });
    record.outputTask = consumeTerminal(record, record.handle.output);
    watch(record);
    return { runtimeId: record.id };
  }

  function waitForWeb(record, callerSignal) {
    const waiter = {};
    record.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        record.waiters.delete(waiter);
        callerSignal?.removeEventListener('abort', cancel);
        callback();
      };
      const cancel = () => {
        finish(() => reject(abortError()));
        if (record.phase === 'starting' && record.waiters.size === 0) record.startController?.abort();
      };
      let settled = false;
      // A Host that restarted itself answers with the replacement's URL, not
      // the URL captured when the Shell spawned the dead process.
      const settle = (value) => {
        if (record.kind === 'web' && record.phase === 'exited') {
          finish(() => reject(failure('RUNTIME_NOT_ACTIVE')));
          return;
        }
        if (record.kind === 'web' && record.phase === 'running' && typeof record.url === 'string') {
          finish(() => resolve({ runtimeId: record.id, url: record.url }));
          return;
        }
        finish(() => resolve(value));
      };
      record.startPromise.then((value) => {
        const pending = record.phase === 'restarting' ? record.restartTask : null;
        if (pending) pending.catch(() => null).then(() => settle(value));
        else settle(value);
      }, (error) => finish(() => reject(error)));
      if (callerSignal?.aborted) cancel();
      else callerSignal?.addEventListener('abort', cancel, { once: true });
    });
  }

  function start(kind, profileId, ownerId, extra) {
    if (disposed) throw failure('SERVICE_DISPOSED');
    identifier(profileId, 'profile');
    identifier(ownerId, 'owner');
    if (profileId === profileContext.name) throw failure('CURRENT_PROFILE_USE_LOCAL');
    const existing = [...records.values()].find((record) => record.profileId === profileId && ACTIVE_PHASES.has(record.phase));
    if (existing && kind === 'web' && existing.kind === 'web') {
      if (existing.phase === 'stopping' || existing.startController?.signal.aborted) throw failure('RUNTIME_NOT_ACTIVE');
      if (existing.ownerId !== ownerId) throw failure('PROFILE_HOST_CONFLICT');
      return waitForWeb(existing, extra.signal);
    }
    if (existing && (kind === 'web' || existing.kind !== 'tui')) throw failure('PROFILE_HOST_CONFLICT');
    if (extra.confirmIndependentHost !== true) throw failure('INDEPENDENT_HOST_CONFIRMATION_REQUIRED');
    if ([...records.values()].filter((record) => ACTIVE_PHASES.has(record.phase)).length >= MAX_ACTIVE_RUNTIMES) {
      throw failure('RUNTIME_LIMIT_REACHED');
    }
    const id = makeId();
    if (records.has(id)) throw failure('RUNTIME_ID_CONFLICT');
    const record = {
      id,
      kind,
      tuiFlavor: null,
      profileId,
      ownerId,
      dshVersion: null,
      phase: 'starting',
      owned: true,
      handle: null,
      startPromise: null,
      stopPromise: null,
      termination: null,
      startController: new AbortController(),
      url: null,
      pid: null,
      port: null,
      adopted: false,
      restartController: null,
      restartTask: null,
      exit: undefined,
      doneObserved: false,
      exitCheckObserved: false,
      waiters: new Set(),
      listeners: new Set(),
      chunks: [],
      bytes: 0,
      firstSeq: 0,
      nextSeq: 0,
      truncatedFirstSeq: null,
      maxBytes: terminalBytes,
      cols: extra.cols,
      rows: extra.rows,
    };
    records.set(record.id, record);
    const signal = record.startController.signal;
    let timer;
    let timedOut = false;
    const callerSignal = kind === 'web' ? undefined : extra.signal;
    const cancel = () => record.startController?.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    record.startPromise = (async () => {
      try {
        timer = timers.setTimeout(() => {
          timedOut = true;
          record.startController?.abort();
        }, startupTimeoutMs);
        timer.unref?.();
        throwIfAborted(callerSignal);
        const [profile, probe] = await Promise.all([loadProfile(profileId), waitForVersion(signal)]);
        throwIfAborted(signal);
        record.dshVersion = probe.version ?? null;
        if (kind === 'web' && !profile.web) throw failure('PROFILE_NOT_FOUND');
        if (kind === 'tui' && profile.tuiConflict) throw failure('TUI_PROFILE_CONFLICT');
        if (kind === 'tui' && !profile.tui) throw failure('TUI_NOT_INSTALLED');
        if (kind === 'tui') {
          record.tuiFlavor = profile.tuiFlavor;
          await verifyTui(profile);
        }
        throwIfAborted(signal);
        const result = kind === 'web'
          ? await startWeb(record, probe.executable, signal)
          : await startTui(record, probe.executable, extra.cwd, signal, extra.command);
        throwIfAborted(signal);
        if (record.phase === 'starting' && !record.doneObserved) record.phase = 'running';
        notify(record);
        return result;
      } catch (error) {
        record.phase = kind === 'web' && record.handle ? 'stopping' : 'failed';
        notify(record);
        await terminateHandle(record).catch(() => null);
        if (timedOut) throw failure('STARTUP_TIMEOUT');
        throw safe(error, kind === 'web' ? 'WEB_STARTUP_FAILED' : 'INVALID_INPUT');
      } finally {
        timers.clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
        record.startController = null;
      }
    })();
    return kind === 'web' ? waitForWeb(record, extra.signal) : record.startPromise;
  }

  /** Lists the readable profiles under `<home>/profiles`, sorted by id. */
  async function catalogProfiles() {
    const profiles = [];
    const warnings = [];
    let entries;
    try {
      const root = await realDirectory(profilesRoot);
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { profiles, warnings, missing: true };
      throw safe(error, 'PROFILE_NOT_FOUND');
    }
    for (const entry of entries.slice(0, 256)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const profile = await loadProfile(entry.name, { allowCurrent: true });
        profiles.push({ id: profile.id, isCurrent: profile.dir === await realDirectory(currentDirectory), web: profile.web, tui: profile.tui, tuiFlavor: profile.tuiFlavor });
      } catch {
        warnings.push({ code: 'PROFILE_CANDIDATE_INVALID', message: ERRORS.PROFILE_CANDIDATE_INVALID });
      }
    }
    profiles.sort((left, right) => left.id.localeCompare(right.id));
    return { profiles, warnings, missing: false };
  }

  async function catalog({ ownerId } = {}) {
    if (ownerId !== undefined) identifier(ownerId, 'owner');
    const listed = await catalogProfiles();
    const profiles = listed.profiles;
    const warnings = listed.warnings;
    for (const record of records.values()) await refreshAdopted(record);
    const discovered = await discoveredRows();
    if (listed.missing) {
      return { currentProfile: profileContext.name, defaultCwd: profileContext.cwd, profiles: [], currentHost: null, runtimes: [...publicRuntimes(ownerId), ...discovered], warnings };
    }
    const current = profiles.find((profile) => profile.isCurrent) ?? null;
    let currentHost = null;
    if (current?.web) {
      const version = await currentVersion();
      currentHost = { current: true, profileId: current.id, ...upgradeFields(current.id, version, null) };
    }
    const stopped = await stoppedProfileRows(profiles);
    return {
      currentProfile: profileContext.name,
      defaultCwd: profileContext.cwd,
      profiles,
      currentHost,
      runtimes: [...publicRuntimes(ownerId), ...stopped, ...discovered],
      warnings,
    };
  }

  // Valid local cards that no active record owns. They can be attached and
  // opened, never stopped or upgraded, and their authenticated URL stays
  // private until `attachDiscovered`.
  async function discoveredRows() {
    let listed;
    try {
      listed = await hostDiscovery.listHostCards({ home: profilesHome });
    } catch {
      return [];
    }
    const hosts = Array.isArray(listed?.hosts) ? listed.hosts : [];
    const active = new Set([...records.values()]
      .filter((record) => ACTIVE_PHASES.has(record.phase))
      .map((record) => record.id));
    const rows = [];
    for (const host of hosts) {
      if (!host || typeof host.instanceId !== 'string' || typeof host.profileId !== 'string') continue;
      // The Desktop profile is never a Guest Web Host. A card there can only
      // come from an older build that mounted the Guest by mistake; it must not
      // turn into a manageable row.
      if (host.profileId === 'desktop') continue;
      if (active.has(host.hostKey)) continue;
      rows.push({
        id: `${DISCOVERED_PREFIX}${host.instanceId}`,
        kind: 'web',
        profileId: host.profileId,
        source: 'discovered',
        phase: 'running',
        owned: false,
        canStop: false,
        attachable: true,
      });
    }
    return rows;
  }

  /**
   * Web profiles that are not running still own an upgrade slot: the launcher
   * shows them as stopped rows so a pending desktop alignment is visible
   * without starting the old plugin set first.
   */
  async function stoppedProfileRows(profiles) {
    if (!upgrades) return [];
    const active = new Set([...records.values()]
      .filter((record) => record.kind === 'web' && ACTIVE_PHASES.has(record.phase))
      .map((record) => record.profileId));
    const ids = [];
    for (const profile of profiles) {
      if (!profile.web || profile.isCurrent || active.has(profile.id)) continue;
      if (profile.id === 'desktop' || profile.id === 'headless') continue;
      ids.push(profile.id);
    }
    if (!ids.length) return [];
    const probe = await probeVersion().catch(() => null);
    const version = typeof probe?.version === 'string' ? probe.version : null;
    return ids.map((profileId) => ({
      id: `profile:${profileId}`,
      kind: 'web',
      profileId,
      source: 'local',
      phase: 'stopped',
      owned: true,
      canStop: false,
      ...upgradeFields(profileId, version, null),
    }));
  }

  function publicRuntimes(ownerId) {
    return [...records.values()].map((record) => {
      const base = {
        id: record.id,
        kind: record.kind,
        profileId: record.profileId,
        source: 'local',
        phase: record.phase,
        owned: true,
        // An adopted Host is not this process's child: ending the record would
        // forget a live Host rather than stop it.
        ...ownerId !== undefined ? { canStop: record.ownerId === ownerId && record.adopted !== true && ACTIVE_PHASES.has(record.phase) } : {},
        ...record.exit ? { exit: record.exit } : {},
      };
      if (record.kind !== 'web') return { ...base, dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : null };
      return { ...base, ...upgradeFields(record.profileId, record.dshVersion, record.id, { probe: ACTIVE_PHASES.has(record.phase) }) };
    });
  }

  return {
    catalog,
    openWeb({ profileId, ownerId, confirmIndependentHost, signal } = {}) {
      return start('web', profileId, ownerId, { confirmIndependentHost, signal });
    },
    async attachWeb({ runtimeId, ownerId } = {}) {
      const record = runtimeById(runtimeId, ownerId, { active: true, kind: 'web' });
      await refreshAdopted(record);
      if (typeof record.url !== 'string') throw failure('RUNTIME_NOT_ACTIVE');
      return { runtimeId: record.id, url: record.url };
    },
    async attachDiscovered({ instanceId, ownerId } = {}) {
      if (typeof instanceId !== 'string' || !/^[a-f0-9]{32}$/u.test(instanceId)) throw failure('INVALID_INPUT');
      identifier(ownerId, 'owner');
      let listed;
      try {
        listed = await hostDiscovery.listHostCards({ home: profilesHome });
      } catch {
        listed = null;
      }
      const host = (Array.isArray(listed?.hosts) ? listed.hosts : [])
        .find((item) => item?.instanceId === instanceId && typeof item.url === 'string');
      if (!host) throw failure('RUNTIME_NOT_FOUND');
      return { runtimeId: `${DISCOVERED_PREFIX}${host.instanceId}`, url: host.url };
    },
    openTui({ profileId, ownerId, cwd, cols, rows, confirmIndependentHost, command, signal } = {}) {
      const size = dimensions(cols, rows);
      absolute(cwd);
      return start('tui', profileId, ownerId, { ...size, cwd, confirmIndependentHost, command, signal });
    },
    async readTerminal({ runtimeId, ownerId, afterSeq = 0 } = {}) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw failure('INVALID_INPUT');
      const record = runtimeById(runtimeId, ownerId, { kind: 'tui' });
      const chunks = record.chunks.filter((chunk) => chunk.seq > afterSeq)
        .map((chunk) => ({ seq: chunk.seq, data: chunk.data }));
      return {
        chunks,
        nextSeq: record.nextSeq,
        firstSeq: record.firstSeq,
        loss: afterSeq < record.firstSeq - 1
          || (record.truncatedFirstSeq !== null && afterSeq < record.truncatedFirstSeq),
        phase: record.phase,
        ...record.exit ? { exit: record.exit } : {},
      };
    },
    subscribeTerminal({ runtimeId, ownerId }, listener) {
      if (typeof listener !== 'function') throw failure('INVALID_INPUT');
      const record = runtimeById(runtimeId, ownerId, { kind: 'tui' });
      record.listeners.add(listener);
      return () => { record.listeners.delete(listener); };
    },
    async writeTerminal({ runtimeId, ownerId, data } = {}) {
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) throw failure('INVALID_INPUT');
      const record = runtimeById(runtimeId, ownerId, { active: true, kind: 'tui' });
      try {
        await record.handle.write(data);
      } catch (error) {
        throw safe(error, 'INVALID_INPUT');
      }
    },
    async resizeTerminal({ runtimeId, ownerId, cols, rows } = {}) {
      const size = dimensions(cols, rows);
      const record = runtimeById(runtimeId, ownerId, { active: true, kind: 'tui' });
      try {
        await record.handle.resize(size.cols, size.rows);
      } catch (error) {
        throw safe(error, 'INVALID_INPUT');
      }
    },
    async stop({ runtimeId, ownerId } = {}) {
      const record = runtimeById(runtimeId, ownerId);
      try {
        await stopRecord(record);
      } catch (error) {
        throw safe(error, 'RUNTIME_STOP_FAILED');
      }
    },
    async upgrade({ runtimeId, ownerId, profileId } = {}) {
      if (!upgrades) throw failure('UPGRADE_RUNTIME_UNAVAILABLE');
      if (runtimeId !== undefined && runtimeId !== null) {
        const record = runtimeById(runtimeId, ownerId, { active: true, kind: 'web' });
        const version = typeof record.dshVersion === 'string' ? record.dshVersion : null;
        return upgrades.start({
          profileId: record.profileId,
          runtimeId: record.id,
          dshVersion: version,
          stopHost: async () => { await stopRecord(record); },
        });
      }
      identifier(ownerId, 'owner');
      // A stopped Web profile has no Host to stop; the probe supplies the CLI
      // version and the executor's own validation rejects non-Web profiles.
      if (typeof profileId === 'string' && profileId && profileId !== profileContext.name) {
        identifier(profileId, 'profile');
        const profile = await loadProfile(profileId);
        if (!profile.web) throw failure('PROFILE_NOT_FOUND');
        const probe = await probeVersion().catch(() => null);
        return upgrades.start({
          profileId,
          runtimeId: null,
          dshVersion: typeof probe?.version === 'string' ? probe.version : null,
          stopHost: null,
        });
      }
      const version = await currentVersion();
      return upgrades.start({ profileId: profileContext.name, runtimeId: null, dshVersion: version, stopHost: null });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        versionController?.abort();
        await versionPromise?.catch(() => null);
        const active = [...records.values()];
        const results = await Promise.allSettled(active.map((record) => stopRecord(record)));
        if (results.some((result) => result.status === 'rejected')) throw failure('RUNTIME_STOP_FAILED');
      })();
      return disposePromise;
    },
  };
}
