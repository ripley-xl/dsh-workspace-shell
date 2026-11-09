const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const MAX_BUNDLES = 256;
const MAX_PENDING_BUILDS = 64;
const AVAILABILITY = new Set(['installation', 'profile', 'missing']);
const LOCAL_PATH = /(?:^|[\s("'=])\/(?:[^\s/]+[\\/])+[^\s]*/u;
const WINDOWS_PATH = /(?:^|[\s("'=])[A-Za-z]:[\\/]/u;
const USER_INFO_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@/u;
const SENSITIVE_URL_QUERY = /[?&](?:access_?token|api_?key|auth|credential|password|secret|token)=/iu;
const FORBIDDEN_LOCALE_KEYS = new Set(['secrets', 'browserurl', 'credentials']);

function unsafeText(value) {
  return value.startsWith('/') || LOCAL_PATH.test(value) || WINDOWS_PATH.test(value)
    || /(?:^|[\s("'=])~[\\/]/u.test(value) || /file:/iu.test(value) || USER_INFO_URL.test(value) || SENSITIVE_URL_QUERY.test(value);
}

function text(value, max = 512, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if (!result || result.length > max || /[\0\r\n]/u.test(result) && !multiline || result.includes('\0') || unsafeText(result)) return null;
  return result;
}

function localizedText(value, { multiline = false } = {}) {
  const direct = text(value, 2048, { multiline });
  if (direct) return direct;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).slice(0, 16);
  const result = {};
  for (const [locale, item] of entries) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(locale) || FORBIDDEN_LOCALE_KEYS.has(locale.toLowerCase())) continue;
    const safe = text(item, 2048, { multiline });
    if (safe) result[locale] = safe;
  }
  return Object.keys(result).length ? result : undefined;
}

function pluginMeta(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const field of ['title', 'description', 'icon', 'error']) {
    const safe = localizedText(value[field], { multiline: field !== 'icon' });
    if (safe !== undefined) result[field] = safe;
  }
  return Object.keys(result).length ? result : undefined;
}

function pendingBuilds(value) {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.slice(0, MAX_PENDING_BUILDS).map((item) => text(item)).filter(Boolean))];
  return result.length ? result : undefined;
}

function pluginSpec(bundle, name, version) {
  const candidate = text(bundle.installTarget?.spec ?? bundle.spec);
  if (candidate) return candidate;
  return version ? `${name}@${version}` : name;
}

function snapshotBytes(snapshot) {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

export function createLocalPluginSnapshot(bundles) {
  if (!Array.isArray(bundles) || bundles.length > MAX_BUNDLES) {
    throw new Error(`Local plugin inventory must be an array with at most ${MAX_BUNDLES} bundles.`);
  }
  const items = bundles.map((bundle, index) => {
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error(`Local plugin bundle ${index} must be an object.`);
    const name = text(bundle.name, 256);
    if (!name) throw new Error(`Local plugin bundle ${index} has an invalid name.`);
    const version = text(bundle.version, 128) ?? undefined;
    const result = {
      name,
      spec: pluginSpec(bundle, name, version),
      enabled: bundle.enabled === true,
      official: bundle.official === true,
      optional: bundle.optional === true,
    };
    if (version) result.version = version;
    const source = text(bundle.source);
    if (source) result.source = source;
    const meta = pluginMeta(bundle.meta);
    if (meta) result.meta = meta;
    if (AVAILABILITY.has(bundle.availability)) result.availability = bundle.availability;
    for (const field of ['installed', 'removable']) {
      if (typeof bundle[field] === 'boolean') result[field] = bundle[field];
    }
    const builds = pendingBuilds(bundle.pendingBuilds);
    if (builds) result.pendingBuilds = builds;
    return result;
  });
  if (new Set(items.map((item) => item.name)).size !== items.length) throw new Error('Local plugin inventory contains duplicate bundle names.');
  const snapshot = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, bundles: items };
  if (snapshotBytes(snapshot) > MAX_SNAPSHOT_BYTES) throw new Error(`Local plugin inventory exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  return snapshot;
}

export async function uploadLocalPluginSnapshot(client, value) {
  const snapshot = Array.isArray(value) ? createLocalPluginSnapshot(value) : value;
  return client.post('/api/ssh-remote/plugins/local-inventory', { snapshot });
}

export async function syncOfficialPlugins(client) {
  return client.post('/api/ssh-remote/plugins/official', {});
}

export async function shareLocalPlugins(client, bundles) {
  const snapshot = createLocalPluginSnapshot(bundles);
  const inventory = await uploadLocalPluginSnapshot(client, snapshot);
  const official = await syncOfficialPlugins(client);
  return {
    ok: inventory?.ok !== false && official?.ok !== false,
    snapshot: inventory?.snapshot ?? snapshot,
    official,
  };
}
