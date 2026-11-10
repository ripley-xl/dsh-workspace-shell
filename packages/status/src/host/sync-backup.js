import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MAX_SYNC_BACKUP_BYTES = 4 * 1024 * 1024;
const MAX_SYNC_BACKUP_ENTRIES = 4096;
const MAX_SYNC_BACKUP_PLUGINS = 1024;
const BACKUP_DIRECTORY = '.ssh-remote-backups';

function entryIdentity(entry) {
  const options = entry?.options ?? {};
  const result = {};
  const id = options.id ?? entry?.id;
  const name = options.name ?? entry?.name;
  const moduleName = options.moduleName ?? entry?.moduleName;
  if (typeof id === 'string') result.id = id;
  if (typeof name === 'string') result.name = name;
  if (typeof moduleName === 'string') result.moduleName = moduleName;
  return result;
}

export function profileDirectory(prepared, configEditor) {
  const directory = prepared?.profileDir ?? prepared?.dir ?? prepared?.profile?.dir;
  const documentPath = (typeof prepared === 'string' ? prepared : undefined)
    ?? prepared?.documentPath ?? prepared?.path ?? prepared?.document?.path ?? configEditor.documentPath;
  const candidate = directory ?? (typeof documentPath === 'string' && documentPath ? dirname(documentPath) : null);
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) throw new Error('The active web profile directory is unavailable.');
  return resolve(candidate);
}

function serializeBackup(value) {
  let serialized;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new Error('The remote configuration cannot be serialized for backup.');
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_SYNC_BACKUP_BYTES) throw new Error(`The remote backup exceeds ${MAX_SYNC_BACKUP_BYTES} bytes.`);
  return { serialized, bytes };
}

async function writePrivateBackup(filePath, serialized) {
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.chmod(0o600);
    await handle.close();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(filePath).catch(() => {});
    }
    throw error;
  }
}

export async function createSyncBackup(ctx, { now = () => new Date(), uuid = randomUUID } = {}) {
  const configuration = ctx.configEditor.configuration();
  const entries = ctx.configEditor.entries();
  const plugins = await ctx.pluginManager.listBundles();
  if (!Array.isArray(configuration) || !Array.isArray(entries) || configuration.length > MAX_SYNC_BACKUP_ENTRIES || entries.length > MAX_SYNC_BACKUP_ENTRIES) {
    throw new Error(`The remote configuration must contain at most ${MAX_SYNC_BACKUP_ENTRIES} entries.`);
  }
  if (!Array.isArray(plugins) || plugins.length > MAX_SYNC_BACKUP_PLUGINS) {
    throw new Error(`The remote plugin inventory must contain at most ${MAX_SYNC_BACKUP_PLUGINS} bundles.`);
  }

  const prepared = typeof ctx.configEditor.prepareDocument === 'function'
    ? await ctx.configEditor.prepareDocument()
    : null;
  const profileDir = profileDirectory(prepared, ctx.configEditor);
  const createdAt = now().toISOString();
  const id = `${createdAt.replace(/[:.]/gu, '-')}-${uuid()}`;
  const content = {
    schemaVersion: 1,
    id,
    createdAt,
    profile: 'web',
    entries: entries.map(entryIdentity),
    configuration: configuration.map((row) => ({
      entry: entryIdentity(row?.entry),
      inherited: row?.inherited ?? {},
      override: row?.override ?? {},
    })),
    plugins,
  };
  const { serialized, bytes } = serializeBackup(content);
  const backupDir = join(profileDir, BACKUP_DIRECTORY);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);
  const filePath = join(backupDir, `${id}.json`);
  await writePrivateBackup(filePath, serialized);
  return {
    ok: true,
    backup: { id, path: filePath, createdAt, profile: 'web', bytes },
  };
}

export function registerSyncBackupRoute(ctx, route, readBody) {
  route('/api/ssh-remote/sync/backup', ['POST'], async (request) => {
    const input = await readBody(request);
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => key !== 'profile')
      || input.profile !== undefined && input.profile !== 'web') {
      throw new Error('The backup request accepts only profile: "web".');
    }
    return createSyncBackup(ctx);
  });
}
