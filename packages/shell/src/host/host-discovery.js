// Host discovery reads the cards Guest Web Hosts publish under
// `<DSH_HOME>/workspace-hosts` (see `packages/guest/src/host/host-card.js`) and
// turns them into validated, live rows.
//
// A card is untrusted input written by another process, so every read here is
// defensive: a bad card is skipped with a code, never thrown. The contract is
// docs/host-restart-design.md §4.1.

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

export const HOST_CARD_VERSION = 1;
export const HOST_CARD_STALE_MS = 30_000;

const MAX_CARD_BYTES = 64 * 1024;
const MAX_CARD_FILES = 256;
const MAX_URL_LENGTH = 2_048;
const INSTANCE = /^[a-f0-9]{32}$/u;
const CARD_FILE = /^([a-f0-9]{32})\.json$/u;
const HOST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const SKIP = {
  INVALID: 'HOST_CARD_INVALID',
  URL: 'HOST_CARD_URL_REJECTED',
  STALE: 'HOST_CARD_STALE',
  DUPLICATE: 'HOST_CARD_DUPLICATE',
};

function cardError(code) {
  return Object.assign(new Error(code), { code, safe: true });
}

/** `<DSH_HOME>/workspace-hosts`: one directory per DSH home, shared by its Hosts. */
export function hostCardDirectory(home) {
  if (typeof home !== 'string' || !home || home.includes('\0') || !path.isAbsolute(home)) {
    throw cardError('HOST_CARD_INVALID_HOME');
  }
  return path.join(home, 'workspace-hosts');
}

/** `process.kill(pid, 0)`: EPERM still proves the pid exists. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loopbackUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return url.protocol === 'http:'
    && LOOPBACK_HOSTS.has(url.hostname)
    && Boolean(url.port)
    && Number.isInteger(port)
    && port > 0
    && port <= 65_535
    && !url.username
    && !url.password;
}

/**
 * Validates one card body. Returns the normalised row or a skip code; it never
 * throws. `instanceId` comes from the file name so a card cannot claim to be
 * another instance.
 */
function readCard(text, file, instanceId) {
  let card;
  try {
    card = JSON.parse(text);
  } catch {
    return { code: SKIP.INVALID };
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) return { code: SKIP.INVALID };
  if (card.version !== HOST_CARD_VERSION) return { code: SKIP.INVALID };
  if (typeof card.instanceId !== 'string' || card.instanceId !== instanceId) return { code: SKIP.INVALID };
  if (typeof card.hostKey !== 'string' || !HOST_KEY.test(card.hostKey)) return { code: SKIP.INVALID };
  if (typeof card.profile !== 'string' || !PROFILE.test(card.profile)) return { code: SKIP.INVALID };
  if (!Number.isInteger(card.pid) || card.pid < 1) return { code: SKIP.INVALID };
  if (!Number.isInteger(card.port) || card.port < 1 || card.port > 65_535) return { code: SKIP.INVALID };
  if (typeof card.supervised !== 'boolean') return { code: SKIP.INVALID };
  const startedAt = timestamp(card.startedAt);
  if (startedAt === null) return { code: SKIP.INVALID };
  const heartbeatAt = timestamp(card.heartbeatAt);
  if (heartbeatAt === null) return { code: SKIP.INVALID };
  if (!loopbackUrl(card.url)) return { code: SKIP.URL };
  return {
    host: {
      file,
      instanceId,
      hostKey: card.hostKey,
      // The card calls this `profile`; catalog rows call it `profileId`.
      profile: card.profile,
      profileId: card.profile,
      pid: card.pid,
      port: card.port,
      url: card.url,
      supervised: card.supervised,
      startedAt: card.startedAt,
      heartbeatAt: card.heartbeatAt,
    },
    startedAtMs: startedAt,
  };
}

/**
 * Lists the live Host cards under `<home>/workspace-hosts`.
 *
 * @param {{ home: string, fs?: object, isAlive?: Function, now?: number|Function, staleMs?: number }} options
 * @returns {Promise<{ hosts: object[], skipped: { file: string, code: string }[] }>}
 */
export async function listHostCards(options = {}) {
  const io = {
    readdir: options?.fs?.readdir ?? nodeFs.readdir,
    readFile: options?.fs?.readFile ?? nodeFs.readFile,
    lstat: options?.fs?.lstat ?? nodeFs.lstat,
  };
  const isAlive = typeof options?.isAlive === 'function' ? options.isAlive : defaultIsAlive;
  const now = options?.now;
  const nowMs = typeof now === 'function' ? Number(now()) : Number.isFinite(now) ? now : Date.now();
  const staleMs = Number.isFinite(options?.staleMs) && options.staleMs >= 0 ? options.staleMs : HOST_CARD_STALE_MS;

  let directory;
  try {
    directory = hostCardDirectory(options?.home);
  } catch {
    return { hosts: [], skipped: [] };
  }

  let names;
  try {
    names = await io.readdir(directory);
  } catch {
    // No card directory means no Guest Host has ever published one.
    return { hosts: [], skipped: [] };
  }
  if (!Array.isArray(names)) return { hosts: [], skipped: [] };

  const skipped = [];
  const rows = [];
  const files = names.filter((name) => typeof name === 'string' && name.endsWith('.json')).sort().slice(0, MAX_CARD_FILES);
  for (const name of files) {
    const file = path.join(directory, name);
    const match = CARD_FILE.exec(name);
    if (!match) {
      skipped.push({ file, code: SKIP.INVALID });
      continue;
    }
    let info;
    try {
      info = await io.lstat(file);
    } catch {
      skipped.push({ file, code: SKIP.INVALID });
      continue;
    }
    // A card is a plain file: a symlink would let another path masquerade as
    // this instance. §9: the file must belong to the current user, so another
    // local account cannot publish a Host the Shell would attach to.
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_CARD_BYTES
      || (uid !== null && typeof info.uid === 'number' && info.uid !== uid)) {
      skipped.push({ file, code: SKIP.INVALID });
      continue;
    }
    let text;
    try {
      text = await io.readFile(file, 'utf8');
    } catch {
      skipped.push({ file, code: SKIP.INVALID });
      continue;
    }
    const result = readCard(text, file, match[1]);
    if (result.code) {
      skipped.push({ file, code: result.code });
      continue;
    }
    let alive = false;
    try {
      alive = Boolean(await isAlive(result.host.pid, result.host));
    } catch {
      alive = false;
    }
    // A live pid outranks a stale heartbeat (a suspended Host still owns its
    // card); only a dead process expires a card. The heartbeat window is
    // reported for diagnostics, never used to reject a live Host.
    if (!alive) {
      skipped.push({ file, code: SKIP.STALE });
      continue;
    }
    rows.push({
      row: { ...result.host, heartbeatStale: nowMs - Date.parse(result.host.heartbeatAt) > staleMs },
      startedAtMs: result.startedAtMs,
    });
  }

  // Several live cards can share a logical identity after a restart; keep only
  // the newest claim and report the rest.
  rows.sort((left, right) => right.startedAtMs - left.startedAtMs
    || right.row.instanceId.localeCompare(left.row.instanceId));
  const hosts = [];
  const claimed = new Set();
  for (const { row } of rows) {
    if (claimed.has(row.hostKey)) {
      skipped.push({ file: row.file, code: SKIP.DUPLICATE });
      continue;
    }
    claimed.add(row.hostKey);
    hosts.push(row);
  }
  return { hosts, skipped };
}
