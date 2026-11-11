// Profile configuration alignment for a reported (guest-managed) Web Host.
//
// DSH keeps a profile's overrides in `cordis.patch.yml`. Aligning a foreign
// Host means: take the entries this machine's same-name profile declares, and
// append the ones the remote profile does not have yet. Existing remote entries
// are never rewritten — a wrong append is recoverable, a wrong rewrite is not.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SshRemoteError } from './ssh/errors.js';

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENTRY_ID = /^-\s+id:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/u;
const MAX_PATCH_BYTES = 512 * 1024;

/** Never ship the Desktop's own management entries to a guest profile. */
const NEVER_SYNC_IDS = new Set(['workspace-shell', 'ssh-remote']);

function checkProfile(profileId) {
  if (typeof profileId !== 'string' || !PROFILE.test(profileId)) {
    throw new SshRemoteError('INVALID_REQUEST', 'The profile identifier is not usable.');
  }
  return profileId;
}

/**
 * Splits a patch list into its top-level entries. Text before the first entry
 * (comments) stays out of the blocks.
 * @returns {{id: string, block: string}[]}
 */
export function parsePatchEntries(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/u);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const match = ENTRY_ID.exec(line);
    if (match) {
      if (current) entries.push(current);
      current = { id: match[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) entries.push(current);
  return entries.map((entry) => ({ id: entry.id, block: entry.lines.join('\n').replace(/\s+$/u, '') + '\n' }));
}

/**
 * Values that only make sense on this machine (absolute user paths, local
 * package specs). Pushing them would point the remote at files it does not have
 * — `plugin-manager`'s `pnpmCommand` is the one that bites: it would break the
 * very `dsh plugin` calls a later sync depends on.
 */
const MACHINE_SPECIFIC = /(?:\/Users\/|\/Applications\/|[A-Za-z]:\\|(?:^|\s)(?:file|link):)/mu;

/**
 * What of the local patch could be added to the remote one.
 * @returns {{append: {id: string, block: string}[], skipped: {id: string, reason: string}[]}}
 */
export function planPatchSync({ localText, remoteText } = {}) {
  const remote = new Set(parsePatchEntries(remoteText).map((entry) => entry.id));
  const seen = new Set();
  const append = [];
  const skipped = [];
  for (const entry of parsePatchEntries(localText)) {
    if (remote.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (NEVER_SYNC_IDS.has(entry.id)) { skipped.push({ id: entry.id, reason: 'desktop-only' }); continue; }
    // A bare `- id: x` declares nothing; syncing it only adds noise.
    if (!/^\s*name:\s*\S/mu.test(entry.block)) continue;
    if (MACHINE_SPECIFIC.test(entry.block)) { skipped.push({ id: entry.id, reason: 'machine-specific' }); continue; }
    append.push(entry);
  }
  return { append, skipped };
}

/** Entries this machine has and the remote profile does not. */
export function missingPatchEntries({ localText, remoteText } = {}) {
  return planPatchSync({ localText, remoteText }).append;
}

/** Reads this machine's patch for the same-name profile. */
export async function readLocalProfilePatch(home, profileId, { fs: fsImpl = fs } = {}) {
  checkProfile(profileId);
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new SshRemoteError('INVALID_REQUEST', 'The local DSH home is not usable.');
  }
  const file = path.join(home, 'profiles', profileId, 'cordis.patch.yml');
  try {
    const text = await fsImpl.readFile(file, 'utf8');
    return text.length > MAX_PATCH_BYTES ? '' : text;
  } catch {
    return '';
  }
}

/** Reads this machine's dependency map for the same-name profile. */
export async function readLocalProfileDependencies(home, profileId, { fs: fsImpl = fs } = {}) {
  checkProfile(profileId);
  if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
  const file = path.join(home, 'profiles', profileId, 'package.json');
  try {
    const manifest = JSON.parse(await fsImpl.readFile(file, 'utf8'));
    const dependencies = manifest?.dependencies;
    return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) ? dependencies : null;
  } catch {
    return null;
  }
}

/** Reads the remote profile's patch. A missing file reads as empty. */
export async function readRemoteProfilePatch(channel, profileId, { signal } = {}) {
  checkProfile(profileId);
  const result = await channel.exec({
    command: 'sh',
    args: ['-c', `cat "$HOME/.dsh/profiles/${profileId}/cordis.patch.yml" 2>/dev/null || true`],
    signal,
    maxStdoutBytes: MAX_PATCH_BYTES,
  });
  if (result.code !== 0) throw new SshRemoteError('REMOTE_CONFIG_SYNC_FAILED', 'The remote profile configuration could not be read.');
  return result.stdout;
}

/**
 * Appends the missing entries, validating the result with the Host's own
 * loader before it replaces the live file. A failed validation restores the
 * backup and reports the reason instead of leaving a profile that cannot boot.
 *
 * @returns {Promise<{appended: string[], backup: string|null, error: string|null}>}
 */
export async function appendRemotePatch(channel, {
  argv, profileId, remoteText, entries, signal, stamp = randomUUID().replaceAll('-', '').slice(0, 12),
} = {}) {
  checkProfile(profileId);
  if (!Array.isArray(entries) || entries.length === 0) return { appended: [], backup: null, error: null };
  if (!Array.isArray(argv) || argv.length < 2) {
    throw new SshRemoteError('INVALID_REQUEST', 'The Host card has no usable interpreter.');
  }
  const directory = `"$HOME/.dsh/profiles/${profileId}"`;
  const target = `${directory}/cordis.patch.yml`;
  const backup = `${directory}/cordis.patch.yml.bak-sync-${stamp}`;
  const temporary = `${directory}/cordis.patch.yml.sync-${stamp}`;

  const base = (remoteText ?? '').replace(/\s+$/u, '');
  const merged = `${base ? `${base}\n` : ''}\n# appended by workspace sync ${new Date().toISOString()}\n${entries.map((entry) => entry.block).join('')}`;

  const local = path.join(os.tmpdir(), `cordis-patch-${stamp}.yml`);
  await fs.writeFile(local, merged, { mode: 0o600 });
  try {
    const backupResult = await channel.exec({ command: 'sh', args: ['-c', `cp ${target} ${backup} 2>/dev/null || true`], signal });
    if (backupResult.code !== 0) throw new SshRemoteError('REMOTE_CONFIG_SYNC_FAILED', 'The remote configuration could not be backed up.');
    await channel.upload(local, temporary.replaceAll('"', ''), { signal });
    const move = await channel.exec({ command: 'mv', args: ['-f', temporary.replaceAll('"', ''), target.replaceAll('"', '')], signal });
    if (move.code !== 0) throw new SshRemoteError('REMOTE_CONFIG_SYNC_FAILED', 'The remote configuration could not be replaced.');
    // The Host's own loader is the only honest validator for this file.
    const check = await channel.exec({
      command: argv[0],
      args: [argv[1], '--profile', profileId, '--dump-config'],
      signal,
      timeoutMs: 120_000,
      maxStdoutBytes: 64 * 1024,
    });
    if (check.code !== 0) {
      await channel.exec({ command: 'sh', args: ['-c', `cp ${backup} ${target} 2>/dev/null || true`], signal }).catch(() => {});
      return {
        appended: [],
        backup: `~/.dsh/profiles/${profileId}/cordis.patch.yml.bak-sync-${stamp}`,
        error: 'the Host rejected the merged configuration',
      };
    }
    return {
      appended: entries.map((entry) => entry.id),
      backup: `~/.dsh/profiles/${profileId}/cordis.patch.yml.bak-sync-${stamp}`,
      error: null,
    };
  } finally {
    await fs.unlink(local).catch(() => {});
  }
}
