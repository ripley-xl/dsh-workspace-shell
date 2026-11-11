import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SshRemoteError } from './ssh/errors.js';

/** Files that are state or secrets rather than a preference. */
const EXCLUDED = /(?:secret|token|grant|credential|password|running|history|cache|discovery|session|ledger)/iu;
// Session-scoped bookkeeping (ids, branches, resumes) means nothing on another
// machine and would point a Host at sessions it does not have.
const STATEFUL = /(?:^|[.-])(?:active|resume|branch|tree|worktree|worktrees|complete|predict|later|installed|board|turkish|untangle|auto-backup|goal|memory|secrets)(?:[.-]|$)/iu;
const PROFILE_FILE = /^\.dsh-[A-Za-z0-9._-]+\.json$/u;
const MAX_BYTES = 256 * 1024;

async function readJsonFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const text = await fs.readFile(file, 'utf8');
  const value = JSON.parse(text);
  // A file that points at a session, a process or a machine is state.
  if (value && typeof value === 'object' && ('sessionId' in value || 'pid' in value || 'host' in value)) return null;
  return { text, size: stat.size };
}

/**
 * Preference files the Desktop owns: the profile-scoped `.dsh-*.json` files and
 * the per-plugin JSON at the top of `storages/<plugin>/`. Runtime state,
 * caches, grants and secrets are left alone.
 */
export async function planPreferenceSync({ home, profileId = 'desktop', fsImpl = fs } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { files: [], skipped: [] };
  const files = [];
  const skipped = [];
  const add = async (file, target) => {
    try {
      const value = await readJsonFile(file);
      if (!value) {
        skipped.push({ path: target, reason: 'not-a-preference' });
        return;
      }
      files.push({ source: file, target, text: value.text });
    } catch (cause) {
      skipped.push({ path: target, reason: 'unreadable' });
    }
  };

  const profileDir = path.join(home, 'profiles', profileId);
  let names = [];
  try {
    names = await fsImpl.readdir(profileDir);
  } catch {
    return { files: [], skipped: [] };
  }
  for (const name of names) {
    if (!PROFILE_FILE.test(name) || EXCLUDED.test(name)) continue;
    await add(path.join(profileDir, name), `profiles/${profileId}/${name}`);
  }

  const storages = path.join(home, 'storages');
  let plugins = [];
  try {
    plugins = await fsImpl.readdir(storages, { withFileTypes: true });
  } catch {
    plugins = [];
  }
  for (const entry of plugins) {
    if (!entry.isDirectory() || EXCLUDED.test(entry.name)) continue;
    let inner = [];
    try {
      inner = await fsImpl.readdir(path.join(storages, entry.name));
    } catch {
      continue;
    }
    for (const name of inner) {
      if (!name.endsWith('.json') || EXCLUDED.test(name) || EXCLUDED.test(entry.name) || STATEFUL.test(name)) continue;
      await add(path.join(storages, entry.name, name), `storages/${entry.name}/${name}`);
    }
  }
  return { files, skipped };
}

/**
 * Copies the planned files next to the remote profile's DSH home. Each target
 * keeps a `.bak-sync-<stamp>` copy; an identical file is not rewritten.
 */
export async function applyPreferenceSync(channel, {
  files, signal, stamp = randomUUID().replaceAll('-', '').slice(0, 12),
} = {}) {
  if (!Array.isArray(files) || files.length === 0) return { synced: [], failed: [], backup: null };
  if (!channel || typeof channel.upload !== 'function') {
    throw new SshRemoteError('INVALID_REQUEST', 'A connected SSH channel is required.');
  }
  const synced = [];
  const failed = [];
  for (const file of files) {
    const remote = `"$HOME/.dsh/${file.target}"`;
    const plain = `$HOME/.dsh/${file.target}`;
    const local = path.join(os.tmpdir(), `dsh-pref-${stamp}-${synced.length}.json`);
    try {
      await fs.writeFile(local, file.text, { mode: 0o600 });
      const backup = await channel.exec({
        command: 'sh', args: ['-c', `[ -f ${remote} ] && cp ${remote} ${remote}.bak-sync-${stamp} 2>/dev/null; mkdir -p "$(dirname ${remote})"`], signal,
      });
      if (backup.code !== 0) throw new Error('backup failed');
      await channel.upload(local, plain, { signal });
      synced.push(file.target);
    } catch {
      failed.push(file.target);
    } finally {
      await fs.unlink(local).catch(() => {});
    }
  }
  return { synced, failed, backup: stamp };
}
