// Remote side of the plugin configuration sync. The manager sends the config
// blocks of the plugins it just installed or upgraded, and this route applies
// them to the matching entries of the running profile.
//
// Only entries named in the request are touched: an entry the request does not
// mention keeps whatever the remote user configured. Every write is preceded by
// the same profile backup the settings sync uses.

import { appendFile, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { createSyncBackup, profileDirectory } from './sync-backup.js';

const MAX_ENTRIES = 32;
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_DEPTH = 6;
const MAX_KEYS = 64;
const MAX_ARRAY = 64;
const MAX_STRING = 2048;
const MAX_NAME = 256;
const MAX_ID = 128;
const SAFE_NAME = /^[@A-Za-z0-9][A-Za-z0-9@/._#+-]{0,255}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET_KEY = /(?:key|token|secret|password|passphrase|credential|authorization|cookie)/iu;
const LOCAL_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|file:|link:)/iu;

function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Infinity;
  }
}

/** Rejects values the remote must not take from another machine. */
function clean(value, depth = 0) {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING || LOCAL_PATH.test(value.trim())) return undefined;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => clean(item, depth + 1)).filter((item) => item !== undefined);
  if (value === null || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (SECRET_KEY.test(key)) continue;
    const cleaned = clean(item, depth + 1);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function validate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The config request must be an object.');
  const entries = value.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error(`entries must contain between 1 and ${MAX_ENTRIES} items.`);
  }
  const seen = new Set();
  const result = [];
  let total = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Every entry must be an object.');
    const name = typeof entry.name === 'string' && SAFE_NAME.test(entry.name) ? entry.name : null;
    if (!name) throw new Error('Every entry needs a safe plugin name.');
    const id = typeof entry.id === 'string' && SAFE_ID.test(entry.id) ? entry.id : null;
    if (entry.config === null || typeof entry.config !== 'object' || Array.isArray(entry.config)) throw new Error('Every entry needs a config object.');
    const config = clean(entry.config);
    if (!config || Object.keys(config).length === 0) continue;
    const bytes = jsonBytes(config);
    if (bytes > MAX_ENTRY_BYTES) throw new Error('A config entry is too large.');
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error('The config request is too large.');
    const key = id ?? name;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...(id ? { id } : {}), name, config });
  }
  return result;
}

function entryIdentity(entry) {
  const options = entry?.options ?? {};
  return {
    id: typeof options.id === 'string' ? options.id : typeof entry?.id === 'string' ? entry.id : null,
    name: typeof options.name === 'string' ? options.name : typeof entry?.name === 'string' ? entry.name : null,
  };
}

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const PATCH_FILE = 'cordis.patch.yml';

/** Ids must be routable in the patch tree; a package name is a safe default. */
function patchId(target) {
  if (target.id) return target.id;
  return target.name.replace(/^@/u, '').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 100) || 'plugin-config';
}

/**
 * Appends one entry to the profile patch layer. The block keeps the same shape
 * the config editor writes: `- id`, `name`, `config`. The config is emitted as
 * a flow mapping, which is valid YAML and needs no serializer.
 */
async function appendPatchEntry(profileDir, target) {
  const file = join(profileDir, PATCH_FILE);
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_PATCH_BYTES) throw new Error('The profile patch file is unavailable.');
  const id = patchId(target);
  const existing = await readFile(file, 'utf8');
  if (new RegExp(`^- id: ${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu').test(existing)) {
    throw new Error('The patch id already exists.');
  }
  const body = JSON.stringify(target.config);
  const block = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}- id: ${id}\n  name: ${JSON.stringify(target.name)}\n  config: ${body}\n`;
  await appendFile(file, block.startsWith('\n') ? block : `\n${block}`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return id;
}

export function registerPluginConfigRoute(ctx, route, readBody) {
  route('/api/ssh-remote/plugins/config', ['POST'], async (request) => {
    const wanted = validate(await readBody(request));
    if (wanted.length === 0) return { ok: true, items: [], backup: null, restartRequired: false };
    const entries = typeof ctx.configEditor?.entries === 'function' ? ctx.configEditor.entries() : null;
    if (!Array.isArray(entries)) throw new Error('The remote configuration editor is unavailable.');
    const listed = typeof ctx.pluginManager?.listBundles === 'function' ? await ctx.pluginManager.listBundles() : [];
    const bundles = Array.isArray(listed) ? listed : [];
    const installed = new Set(bundles.filter((bundle) => bundle?.installed === true && typeof bundle.name === 'string').map((bundle) => bundle.name));
    const prepared = typeof ctx.configEditor.prepareDocument === 'function' ? await ctx.configEditor.prepareDocument() : null;
    let profileDir = null;
    try {
      profileDir = profileDirectory(prepared, ctx.configEditor);
    } catch {
      profileDir = null;
    }
    const backup = await createSyncBackup(ctx);
    const items = [];
    let restartRequired = false;
    for (const target of wanted) {
      const match = entries.find((entry) => {
        const identity = entryIdentity(entry);
        return target.id ? identity.id === target.id : identity.name === target.name;
      }) ?? entries.find((entry) => entryIdentity(entry).name === target.name);
      if (match) {
        try {
          await ctx.configEditor.edit(match, () => target.config);
          items.push({ ...(target.id ? { id: target.id } : {}), name: target.name, ok: true });
        } catch (error) {
          items.push({ ...(target.id ? { id: target.id } : {}), name: target.name, ok: false, error: failure(error).slice(0, 160) });
        }
        continue;
      }
      // A new entry is only created for a plugin this profile actually has and
      // only when nothing with the same id or name exists yet, so a bundle's own
      // row is never duplicated.
      if (!installed.has(target.name) || !profileDir) {
        items.push({ ...(target.id ? { id: target.id } : {}), name: target.name, ok: false, error: 'entry-missing' });
        continue;
      }
      const id = patchId(target);
      if (entries.some((entry) => entryIdentity(entry).id === id || entryIdentity(entry).name === target.name)) {
        items.push({ ...(target.id ? { id: target.id } : {}), name: target.name, ok: false, error: 'entry-missing' });
        continue;
      }
      try {
        const createdId = await appendPatchEntry(profileDir, target);
        restartRequired = true;
        items.push({ id: createdId, name: target.name, ok: true, created: true });
      } catch (error) {
        items.push({ ...(target.id ? { id: target.id } : {}), name: target.name, ok: false, error: failure(error).slice(0, 160) });
      }
    }
    return { ok: items.every((item) => item.ok), items, backup: backup?.backup ?? null, restartRequired };
  });
}
