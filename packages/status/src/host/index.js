import { registerPluginSharingRoutes } from './plugin-sharing.js';
import { registerSyncBackupRoute } from './sync-backup.js';

const JSON_HEADERS = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 64 * 1024;

function json(value, status = 200) {
  return Response.json(value, { status, headers: JSON_HEADERS });
}

async function body(request) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('request body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text.trim() ? JSON.parse(text) : {};
}

function route(ctx, path, methods, handler) {
  ctx.effect(() => ctx.connection.fetch.register({
    path, methods, requestBody: 'buffered',
    async fetch(request) {
      try {
        return json(await handler(request));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  }), `ssh-remote-status: ${path}`);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function packageIdentity(spec) {
  const separator = spec.lastIndexOf('@');
  return separator > 0
    ? { name: spec.slice(0, separator), version: spec.slice(separator + 1) }
    : { name: spec, version: null };
}

async function installPlugin(ctx, input) {
  const spec = nonEmptyString(input.spec, 'spec');
  let result = await ctx.pluginManager.installBundle(spec, {
    enabled: true,
    saveExact: true,
    requestId: nonEmptyString(input.requestId, 'requestId'),
    ...Array.isArray(input.approvedBuilds) ? { approvedBuilds: input.approvedBuilds } : {},
    ...typeof input.registry === 'string' || input.registry === null ? { registry: input.registry } : {},
  });
  if (result.application === 'failed' && result.error?.code === 'already-installed') {
    const identity = packageIdentity(spec);
    const existing = (await ctx.pluginManager.listBundles()).find((bundle) => bundle.name === identity.name);
    if (!existing || identity.version && existing.version !== identity.version) {
      result = {
        ...result,
        error: {
          code: 'PLUGIN_VERSION_MISMATCH',
          message: `Remote ${identity.name} is already installed with a different version.`,
          details: { requestedVersion: identity.version, remoteVersion: existing?.version ?? null },
        },
      };
    } else if (existing.enabled !== true) {
      result = { ...await ctx.pluginManager.setBundleEnabled(existing.name, true), alreadyInstalled: true };
    } else {
      const { error: ignored, ...rest } = result;
      result = { ...rest, application: 'applied', changed: false, alreadyInstalled: true };
    }
  }
  return { ok: result.application !== 'failed', result };
}

export const inject = ['connection', 'pluginManager', 'settings', 'credentials', 'configEditor'];

export function apply(ctx, config) {
  route(ctx, '/api/ssh-remote/status', ['GET'], async () => ({
    ok: true,
    role: 'remote',
    hostAlias: config.hostAlias,
    dshVersion: config.dshVersion,
    capabilities: ['plugins', 'plugin-sharing', 'settings', 'credentials', 'sync-preview', 'sync-backup'],
  }));

  route(ctx, '/api/ssh-remote/plugins/list', ['POST'], async () => ({
    ok: true,
    bundles: await ctx.pluginManager.listBundles(),
  }));

  route(ctx, '/api/ssh-remote/plugins/install', ['POST'], async (request) => {
    const input = await body(request);
    return installPlugin(ctx, input);
  });

  registerPluginSharingRoutes(ctx, (path, methods, handler) => route(ctx, path, methods, handler), body);
  registerSyncBackupRoute(ctx, (path, methods, handler) => route(ctx, path, methods, handler), body);

  route(ctx, '/api/ssh-remote/settings/describe', ['POST'], async () => ({
    ok: true,
    descriptors: ctx.settings.describe({ redactSecrets: true }),
  }));

  route(ctx, '/api/ssh-remote/settings/update', ['POST'], async (request) => {
    const input = await body(request);
    const ns = nonEmptyString(input.ns, 'ns');
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw new Error('patch must be an object');
    await ctx.settings.update(ns, input.patch, input.expectedRevision);
    return { ok: true };
  });

  route(ctx, '/api/ssh-remote/credentials/describe', ['POST'], async (request) => {
    const input = await body(request);
    if (!Array.isArray(input.refs) || input.refs.length > 128) throw new Error('refs must be an array with at most 128 items');
    const refs = [...new Set(input.refs.map((ref) => nonEmptyString(ref, 'ref')))];
    const entries = await Promise.all(refs.map(async (ref) => {
      const descriptor = await ctx.credentials.describe(ref);
      return [ref, { configured: descriptor.configured === true, writable: descriptor.writable === true }];
    }));
    return { ok: true, credentials: Object.fromEntries(entries) };
  });

  route(ctx, '/api/ssh-remote/credentials/set', ['POST'], async (request) => {
    const input = await body(request);
    const ref = nonEmptyString(input.ref, 'ref');
    const value = nonEmptyString(input.value, 'value');
    await ctx.credentials.set(ref, value);
    return { ok: true, credential: await ctx.credentials.describe(ref) };
  });
}
