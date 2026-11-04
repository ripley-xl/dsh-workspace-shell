export const LOCAL_PLUGIN_SNAPSHOT_SCHEMA = 1;
export const MAX_LOCAL_PLUGIN_SNAPSHOT_BYTES = 48 * 1024;
export const MAX_LOCAL_PLUGIN_BUNDLES = 256;
export const MAX_LOCAL_PLUGIN_PENDING_BUILDS = 64;

const SNAPSHOT_FIELDS = new Set(['schemaVersion', 'bundles']);
const BUNDLE_FIELDS = new Set([
  'name', 'spec', 'version', 'source', 'meta', 'enabled', 'official', 'optional',
  'availability', 'installed', 'removable', 'pendingBuilds',
]);
const META_FIELDS = new Set(['title', 'description', 'icon', 'error']);
const AVAILABILITY = new Set(['installation', 'profile', 'missing']);
const LOCAL_PATH = /(?:^|[\s("'=])\/(?:[^\s/]+[\\/])+[^\s]*/u;
const WINDOWS_PATH = /(?:^|[\s("'=])[A-Za-z]:[\\/]/u;
const USER_INFO_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@/u;
const SENSITIVE_URL_QUERY = /[?&](?:access_?token|api_?key|auth|credential|password|secret|token)=/iu;
const FORBIDDEN_LOCALE_KEYS = new Set(['secrets', 'browserurl', 'credentials']);

function invalid(message) {
  const error = new Error(`Invalid local plugin snapshot: ${message}`);
  error.code = 'INVALID_LOCAL_PLUGIN_SNAPSHOT';
  return error;
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value;
}

function onlyFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${label}.${key} is not allowed.`);
  }
}

function safeString(value, label, { max = 512, required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/u.test(value)) {
    throw invalid(`${label} must be a non-empty single-line string of at most ${max} characters.`);
  }
  if (value.startsWith('/') || LOCAL_PATH.test(value) || WINDOWS_PATH.test(value) || /(?:^|[\s("'=])~[\\/]/u.test(value) || /file:/iu.test(value) || USER_INFO_URL.test(value) || SENSITIVE_URL_QUERY.test(value)) {
    throw invalid(`${label} must not contain a local path or URL credentials.`);
  }
  return value;
}

function localizedText(value, label) {
  if (typeof value === 'string') {
    if (value.startsWith('/') || value.length > 2048 || value.includes('\0') || LOCAL_PATH.test(value) || WINDOWS_PATH.test(value) || /(?:^|[\s("'=])~[\\/]/u.test(value) || /file:/iu.test(value) || USER_INFO_URL.test(value) || SENSITIVE_URL_QUERY.test(value)) {
      throw invalid(`${label} contains a local path, URL credentials, or too much text.`);
    }
    return value;
  }
  object(value, label);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) throw invalid(`${label} must contain between 1 and 16 locales.`);
  const result = {};
  for (const [locale, text] of entries) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(locale) || FORBIDDEN_LOCALE_KEYS.has(locale.toLowerCase()) || typeof text !== 'string') throw invalid(`${label} has an invalid locale entry.`);
    result[locale] = localizedText(text, `${label}.${locale}`);
  }
  return result;
}

function meta(value, label) {
  object(value, label);
  onlyFields(value, META_FIELDS, label);
  const result = {};
  for (const field of META_FIELDS) {
    if (value[field] !== undefined) result[field] = localizedText(value[field], `${label}.${field}`);
  }
  return result;
}

function boolean(value, label, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${label} must be boolean.`);
  return value;
}

function pendingBuilds(value, label) {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_PLUGIN_PENDING_BUILDS) {
    throw invalid(`${label} must be an array with at most ${MAX_LOCAL_PLUGIN_PENDING_BUILDS} items.`);
  }
  const result = value.map((item, index) => safeString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw invalid(`${label} must not contain duplicates.`);
  return result;
}

function bundle(value, index) {
  const label = `bundles[${index}]`;
  object(value, label);
  onlyFields(value, BUNDLE_FIELDS, label);
  const result = {
    name: safeString(value.name, `${label}.name`, { max: 256 }),
    enabled: boolean(value.enabled, `${label}.enabled`),
    official: boolean(value.official, `${label}.official`),
    optional: boolean(value.optional, `${label}.optional`),
  };
  for (const [field, max] of [['spec', 512], ['version', 128], ['source', 512]]) {
    const item = safeString(value[field], `${label}.${field}`, { max, required: false });
    if (item !== undefined) result[field] = item;
  }
  if (value.meta !== undefined) result.meta = meta(value.meta, `${label}.meta`);
  if (value.availability !== undefined) {
    if (!AVAILABILITY.has(value.availability)) throw invalid(`${label}.availability is invalid.`);
    result.availability = value.availability;
  }
  for (const field of ['installed', 'removable']) {
    const item = boolean(value[field], `${label}.${field}`, { required: false });
    if (item !== undefined) result[field] = item;
  }
  if (value.pendingBuilds !== undefined) result.pendingBuilds = pendingBuilds(value.pendingBuilds, `${label}.pendingBuilds`);
  return result;
}

function serializedBytes(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalid('snapshot must be JSON serializable.');
  }
  if (serialized === undefined) throw invalid('snapshot must be JSON serializable.');
  return new TextEncoder().encode(serialized).byteLength;
}

export function validateLocalPluginSnapshot(value) {
  object(value, 'snapshot');
  onlyFields(value, SNAPSHOT_FIELDS, 'snapshot');
  if (value.schemaVersion !== LOCAL_PLUGIN_SNAPSHOT_SCHEMA) throw invalid('schemaVersion must be 1.');
  if (!Array.isArray(value.bundles) || value.bundles.length > MAX_LOCAL_PLUGIN_BUNDLES) {
    throw invalid(`bundles must be an array with at most ${MAX_LOCAL_PLUGIN_BUNDLES} items.`);
  }
  if (serializedBytes(value) > MAX_LOCAL_PLUGIN_SNAPSHOT_BYTES) {
    throw invalid(`snapshot must be at most ${MAX_LOCAL_PLUGIN_SNAPSHOT_BYTES} bytes.`);
  }
  const bundles = value.bundles.map(bundle);
  const names = bundles.map((item) => item.name);
  if (new Set(names).size !== names.length) throw invalid('bundles must not contain duplicate names.');
  return { schemaVersion: LOCAL_PLUGIN_SNAPSHOT_SCHEMA, bundles };
}

function operationFailed(result) {
  return !result || result.application === 'failed' || result.application === 'cancelled';
}

function publicFailure(error) {
  return error instanceof Error ? error.message : String(error);
}

export function registerPluginSharingRoutes(ctx, route, readBody) {
  let localSnapshot = null;

  route('/api/ssh-remote/plugins/local-inventory', ['POST'], async (request) => {
    const input = await readBody(request);
    object(input, 'request');
    onlyFields(input, new Set(['snapshot']), 'request');
    const snapshot = validateLocalPluginSnapshot(input.snapshot);
    localSnapshot = snapshot;
    return { ok: true, snapshot };
  });

  route('/api/ssh-remote/plugins/page', ['POST'], async () => ({
    ok: true,
    local: localSnapshot,
    remote: await ctx.pluginManager.listBundles(),
  }));

  route('/api/ssh-remote/plugins/official', ['POST'], async () => {
    if (!localSnapshot) throw new Error('Local plugin snapshot is unavailable.');
    const remote = await ctx.pluginManager.listBundles();
    const desired = localSnapshot.bundles.filter((item) => item.official && item.optional);
    const items = [];
    let restartRequired = false;
    for (const local of desired) {
      const target = remote.find((item) => item?.name === local.name);
      if (!target || target.official !== true || target.optional !== true) {
        items.push({ name: local.name, enabled: local.enabled, ok: false, error: 'The remote bundle is not an official optional bundle.' });
        continue;
      }
      if (target.enabled === local.enabled) {
        items.push({ name: local.name, enabled: local.enabled, ok: true, changed: false, application: 'applied' });
        continue;
      }
      try {
        const result = await ctx.pluginManager.setBundleEnabled(local.name, local.enabled);
        const ok = !operationFailed(result);
        restartRequired ||= result?.application === 'restart-required';
        items.push({
          name: local.name,
          enabled: local.enabled,
          ok,
          changed: result?.changed === true,
          application: result?.application,
          ...ok ? {} : { error: result?.error?.diagnostic || 'Remote bundle enablement failed.' },
        });
      } catch (error) {
        items.push({ name: local.name, enabled: local.enabled, ok: false, error: publicFailure(error) });
      }
    }
    return { ok: items.every((item) => item.ok), restartRequired, items };
  });

  route('/api/ssh-remote/plugins/set-enabled', ['POST'], async (request) => {
    const input = await readBody(request);
    const name = safeString(input.name, 'name', { max: 256 });
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean.');
    const result = await ctx.pluginManager.setBundleEnabled(name, input.enabled);
    return { ok: !operationFailed(result), result };
  });

  route('/api/ssh-remote/plugins/remove', ['POST'], async (request) => {
    const input = await readBody(request);
    const name = safeString(input.name, 'name', { max: 256 });
    const result = await ctx.pluginManager.removeBundle(name);
    return { ok: !operationFailed(result), result };
  });
}
