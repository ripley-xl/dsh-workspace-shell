// The Host card: a Guest Web Host publishes who it is (pid, port, page URL,
// boot argv) into `<DSH_HOME>/workspace-hosts/`, so any supervisor that did not
// spawn it — the framing Shell, a launcher, a future controller — can discover
// it, attach to it, and follow it across a restart.
//
// A card is a live claim, not a record: a 5s heartbeat keeps it fresh, a dead
// pid makes it worthless, and a graceful shutdown removes it. Readers must
// validate before trusting (see packages/shell/src/host/host-discovery.js).

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CARD_VERSION = 1;
export const CARD_HEARTBEAT_MS = 5_000;
const INSTANCE = /^[a-f0-9]{32}$/;
const HOST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_URL = 2_048;
const MAX_ARGUMENTS = 256;

const cardError = (code) => Object.assign(new Error(code), { code, safe: true });

export function newInstanceId() {
  return randomUUID().replaceAll('-', '');
}

/** `<DSH_HOME>/workspace-hosts`: one directory per DSH home, shared by its Hosts. */
export function hostCardDirectory(home) {
  if (typeof home !== 'string' || !home || home.includes('\0') || !path.isAbsolute(home)) throw cardError('HOST_CARD_INVALID_HOME');
  return path.join(home, 'workspace-hosts');
}

export function cardFileName(instanceId) {
  if (!INSTANCE.test(instanceId)) throw cardError('HOST_CARD_INVALID_INSTANCE');
  return `${instanceId}.json`;
}

/** The Shell injects this key when it spawns a Host; unowned Hosts fall back to the profile. */
export function hostKeyFor(profile, injected) {
  if (typeof injected === 'string' && HOST_KEY.test(injected)) return injected;
  if (typeof profile === 'string' && PROFILE.test(profile)) return `profile:${profile}`;
  return 'profile:unknown';
}

function isLoopbackUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && Boolean(url.port) && !url.username && !url.password;
}

function validate(options) {
  const { profile, port, url, cwd, argv, dshVersion, guestVersion, supervised } = options;
  if (typeof profile !== 'string' || !PROFILE.test(profile)) throw cardError('HOST_CARD_INVALID_PROFILE');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw cardError('HOST_CARD_INVALID_PORT');
  if (!isLoopbackUrl(url)) throw cardError('HOST_CARD_INVALID_URL');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw cardError('HOST_CARD_INVALID_CWD');
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS || argv.some((part) => typeof part !== 'string' || part.includes('\0'))) {
    throw cardError('HOST_CARD_INVALID_ARGV');
  }
  if (typeof supervised !== 'boolean') throw cardError('HOST_CARD_INVALID_SUPERVISED');
  if (dshVersion !== null && typeof dshVersion !== 'string') throw cardError('HOST_CARD_INVALID_VERSION');
  if (guestVersion !== null && typeof guestVersion !== 'string') throw cardError('HOST_CARD_INVALID_VERSION');
}

/**
 * A directory whose contents only this user can read. Mirrors the session-Host
 * registry contract: no symlink, owner-only mode. Platforms without `getuid`
 * (Windows) keep the directory but skip the POSIX checks they cannot answer.
 */
async function privateDirectory(directory, fs) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw cardError('HOST_CARD_DIRECTORY_UNSAFE');
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw cardError('HOST_CARD_DIRECTORY_UNSAFE');
  }
  return fs.realpath(directory);
}

/**
 * Publishes one card and keeps it fresh until `dispose()`.
 *
 * @returns {Promise<{ instanceId, hostKey, file, snapshot, refresh, dispose }>}
 */
export async function createHostCard(options = {}) {
  const {
    home, instanceId = newInstanceId(), heartbeatMs = CARD_HEARTBEAT_MS, pid = process.pid,
    startedAt = new Date(), fs = nodeFs, timers = { setInterval, clearInterval },
  } = options;
  const profile = options.profile;
  const supervised = options.supervised === true;
  const hostKey = hostKeyFor(profile, options.hostKey);
  validate({
    profile,
    port: options.port,
    url: options.url,
    cwd: options.cwd,
    argv: options.argv,
    supervised,
    dshVersion: options.dshVersion ?? null,
    guestVersion: options.guestVersion ?? null,
  });
  if (!INSTANCE.test(instanceId)) throw cardError('HOST_CARD_INVALID_INSTANCE');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) throw cardError('HOST_CARD_INVALID_HEARTBEAT');

  const directory = await privateDirectory(hostCardDirectory(home), fs);
  const file = path.join(directory, cardFileName(instanceId));
  const card = {
    version: CARD_VERSION,
    instanceId,
    hostKey,
    profile,
    pid,
    port: options.port,
    url: options.url,
    startedAt: new Date(startedAt).toISOString(),
    heartbeatAt: new Date().toISOString(),
    supervised,
    cwd: options.cwd,
    argv: [...options.argv],
    dshVersion: options.dshVersion ?? null,
    guestVersion: options.guestVersion ?? null,
  };

  let disposed = false;
  let inFlight = null;
  let timer;
  let identity = null;
  const temporary = () => path.join(directory, `${instanceId}.${process.pid}.tmp`);

  const write = () => {
    card.heartbeatAt = new Date().toISOString();
    const body = JSON.stringify(card) + '\n';
    const temp = temporary();
    return (async () => {
      await fs.writeFile(temp, body, { mode: 0o600 });
      // writeFile's mode is creation-only; repeat it for a pre-existing temp file.
      await fs.chmod(temp, 0o600).catch(() => {});
      await fs.rename(temp, file);
      // Each heartbeat renames a new inode over the old one; keep the latest so
      // dispose() compares against what this card actually published last.
      identity = await fs.lstat(file).catch(() => identity);
    })();
  };
  const schedule = () => {
    if (disposed) return;
    inFlight = write().catch(() => {}).finally(() => { inFlight = null; });
  };

  await write();
  timer = timers.setInterval(schedule, heartbeatMs);
  if (typeof timer?.unref === 'function') timer.unref();

  return Object.freeze({
    instanceId,
    hostKey,
    file,
    snapshot: () => ({ ...card, argv: [...card.argv] }),
    refresh: () => write(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      timers.clearInterval(timer);
      await inFlight?.catch(() => {});
      // Never delete a replacement that reused this path.
      const current = await fs.lstat(file).catch(() => null);
      if (current && identity && current.ino === identity.ino && current.dev === identity.dev) {
        await fs.unlink(file).catch(() => {});
      }
      await fs.unlink(temporary()).catch(() => {});
    },
  });
}
