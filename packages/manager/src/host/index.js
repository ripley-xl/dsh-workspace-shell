import { ConnectionStore } from './store.js';
import { RuntimeCatalog } from './runtime-catalog.js';
import { SshRemoteService } from './service.js';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './profiles.js';
import { SshRemoteError } from './ssh/errors.js';
import { publicError } from './diagnostics.js';

const JSON_HEADERS = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENT_CLIENTS = 32;

function json(value, status = 200) {
  return Response.json(value, { status, headers: JSON_HEADERS });
}

function httpStatus(code) {
  if (code === 'HOST_NOT_FOUND') return 404;
  if (code === 'SERVICE_DISPOSED') return 503;
  if (code === 'LOCAL_DSH_OUTDATED' || code === 'SYNC_CONFIRMATION_REQUIRED' || code === 'HOST_BUSY'
    || code === 'HOST_NOT_CONNECTED' || code === 'PROFILE_NOT_WEB' || code === 'REMOTE_INSTANCE_UNAVAILABLE') return 409;
  if (code === 'OPERATION_TIMEOUT') return 504;
  if (code?.startsWith('SSH_') || code?.startsWith('REMOTE_') || code === 'CREDENTIAL_UNAVAILABLE') return 502;
  return 400;
}

function errorResponse(cause) {
  const error = publicError(cause) ?? { code: 'REMOTE_OPERATION_FAILED', message: 'The SSH Remote operation failed.' };
  return json({ ok: false, error }, httpStatus(error.code));
}

async function body(request) {
  if (!request.body) return {};
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    await request.body.cancel();
    throw new SshRemoteError('INVALID_REQUEST', 'The request body is too large.');
  }
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
        throw new SshRemoteError('INVALID_REQUEST', 'The request body is too large.');
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
  try {
    const value = text.trim() ? JSON.parse(text) : {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new SshRemoteError('INVALID_REQUEST', 'The request body must be a JSON object.');
  }
}

function hostId(input) {
  const value = input.hostId ?? input.id;
  if (typeof value !== 'string' || value.length === 0) throw new SshRemoteError('INVALID_REQUEST', 'hostId is required.');
  return value;
}

function instanceId(input) {
  const value = input.instanceId;
  if (typeof value !== 'string' || value.length === 0) throw new SshRemoteError('INVALID_REQUEST', 'instanceId is required.');
  return value;
}

function profileId(input) {
  const value = input.profileId ?? input.profile;
  if (value === undefined) return DEFAULT_PROFILE_ID;
  try {
    return normalizeProfileId(value);
  } catch {
    throw new SshRemoteError('INVALID_REQUEST', 'profileId must be a profile identifier of at most 128 characters.');
  }
}

async function dshVersion(ctx) {
  const bundles = await ctx.pluginManager.listBundles();
  const available = bundles.filter((bundle) => bundle.enabled !== false
    && bundle.availability !== 'missing'
    && typeof bundle.version === 'string'
    && bundle.version.length > 0);
  return available.find((bundle) => bundle.name === '@deepseek-ai/dsh-web-app')?.version
    ?? available.find((bundle) => bundle.name === '@deepseek-ai/dsh-base')?.version
    ?? null;
}

function sse(service, request, onClose) {
  let controller;
  let heartbeat;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    service.off('connection', onConnection);
    service.off('removed', onRemoved);
    service.interactions.off('interaction', onInteraction);
    service.interactions.off('interaction-ended', onInteractionEnded);
    request.signal.removeEventListener('abort', abort);
    onClose();
  };
  const encoder = new TextEncoder();
  const send = (event, value) => {
    if (closed || !controller || controller.desiredSize <= 0) return;
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
  };
  const onConnection = (connection) => send('connection', connection);
  const onRemoved = (value) => send('removed', value);
  const onInteraction = (value) => send('interaction', value);
  const onInteractionEnded = (value) => send('interaction-ended', value);
  const abort = () => {
    cleanup();
    controller?.close();
  };
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      service.on('connection', onConnection);
      service.on('removed', onRemoved);
      service.interactions.on('interaction', onInteraction);
      service.interactions.on('interaction-ended', onInteractionEnded);
      request.signal.addEventListener('abort', abort, { once: true });
      heartbeat = setInterval(() => send('ping', {}), 15_000);
      heartbeat.unref?.();
      void service.status().then((value) => send('status', value)).catch(() => abort());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'cache-control': 'no-store, no-cache',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
}

export const inject = ['connection', 'pluginManager', 'settings', 'credentials', 'storageDomain'];

export async function apply(ctx) {
  const store = await new ConnectionStore(ctx.storageDomain).open();
  const service = new SshRemoteService({
    store,
    catalog: new RuntimeCatalog(),
    localVersion: () => dshVersion(ctx),
    localBundles: () => ctx.pluginManager.listBundles(),
    localReturnUrl: ctx.get('webApp')?.getAdvertisedUrl() ?? 'http://127.0.0.1:54542',
    settings: ctx.settings,
    credentials: ctx.credentials,
  });
  let eventClients = 0;

  function route(path, methods, handler, { events = false } = {}) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      async fetch(request) {
        if (events) {
          if (eventClients >= MAX_EVENT_CLIENTS) return json({ ok: false, error: { code: 'TOO_MANY_EVENTS', message: 'Too many event streams.' } }, 429);
          eventClients += 1;
          return sse(service, request, () => { eventClients -= 1; });
        }
        try {
          return json(await handler(request));
        } catch (cause) {
          return errorResponse(cause);
        }
      },
    }), `ssh-remote: ${path}`);
  }

  route('/api/ssh-remote/status', ['GET'], () => service.status());
  route('/api/ssh-remote/events', ['GET'], null, { events: true });
  route('/api/ssh-remote/ssh-hosts', ['GET', 'POST'], async (request) => {
    const input = await body(request);
    const query = request.method === 'GET' ? new URL(request.url).searchParams.get('query') ?? '' : input.query ?? '';
    return service.sshHosts({ query });
  });
  route('/api/ssh-remote/hosts', ['POST'], async (request) => {
    const input = await body(request);
    if (input.action === 'remove' || input.op === 'remove') return service.remove(hostId(input));
    if (input.action !== undefined && input.action !== 'upsert') throw new SshRemoteError('INVALID_REQUEST', 'hosts action must be upsert or remove.');
    const value = input.host ?? input;
    if (value.hostId !== undefined && value.id === undefined) value.id = value.hostId;
    return service.upsert(value);
  });
  route('/api/ssh-remote/connect', ['POST'], async (request) => {
    const input = await body(request);
    return service.connect(hostId(input));
  });
  route('/api/ssh-remote/disconnect', ['POST'], async (request) => service.disconnect(hostId(await body(request))));
  route('/api/ssh-remote/sync/preview', ['POST'], async (request) => {
    const id = hostId(await body(request));
    const preview = await service.previewSync(id);
    return { ok: true, host: service.publicConnection(id), preview };
  });
  route('/api/ssh-remote/sync', ['POST'], async (request) => {
    const input = await body(request);
    const id = hostId(input);
    const report = await service.sync(id, { allowConflicts: input.allowConflicts ?? input.confirmConflicts ?? false });
    return { ok: true, host: service.publicConnection(id), sync: report };
  });
  route('/api/ssh-remote/stop', ['POST'], async (request) => {
    const input = await body(request);
    return service.stop(hostId(input), { instanceId: input.instanceId });
  });
  route('/api/ssh-remote/web/list', ['POST'], async (request) => {
    const input = await body(request);
    const listed = await service.webList(hostId(input));
    return {
      ok: true,
      profiles: listed.profiles,
      hosts: listed.hosts,
      profilesSource: listed.profilesSource,
      connected: listed.connected,
    };
  });
  route('/api/ssh-remote/web/open', ['POST'], async (request) => {
    const input = await body(request);
    const host = await service.webOpen(hostId(input), {
      profileId: profileId(input),
      profileName: typeof input.profileName === 'string' ? input.profileName.slice(0, 256) : undefined,
      signal: request.signal,
    });
    return { ok: true, instanceId: host.instanceId, url: host.url, profileId: host.profileId };
  });
  route('/api/ssh-remote/web/attach', ['POST'], async (request) => {
    const input = await body(request);
    const host = await service.webAttach(hostId(input), { instanceId: instanceId(input) });
    return { ok: true, instanceId: host.instanceId, url: host.url, profileId: host.profileId };
  });
  route('/api/ssh-remote/web/stop', ['POST'], async (request) => {
    const input = await body(request);
    const stopped = await service.webStop(hostId(input), { instanceId: instanceId(input) });
    return { ok: true, instanceId: stopped.instanceId, profileId: stopped.profileId };
  });
  route('/api/ssh-remote/autoconnect', ['POST'], async (request) => {
    const input = await body(request);
    const id = hostId(input);
    if (typeof input.autoConnect !== 'boolean') throw new SshRemoteError('INVALID_REQUEST', 'autoConnect must be boolean.');
    const result = await service.upsert({ id, autoConnect: input.autoConnect });
    return { ok: true, host: result.host };
  });
  route('/api/ssh-remote/interaction', ['POST'], async (request) => {
    const input = await body(request);
    if (typeof input.requestId !== 'string' || !input.requestId) throw new SshRemoteError('INVALID_REQUEST', 'requestId is required.');
    const handled = input.cancel === true
      ? service.interactions.cancel(input.requestId)
      : service.interactions.answer(input.requestId, input);
    if (!handled) throw new SshRemoteError('INTERACTION_NOT_FOUND', 'The interaction is no longer active.');
    return { ok: true, handled: true };
  });
  route('/api/ssh-remote/ports', ['POST'], async (request) => {
    const input = await body(request);
    const id = hostId(input);
    let result = null;
    if (input.action === 'add') result = await service.addPort(id, input.forward ?? input);
    else if (input.action === 'remove') result = await service.removePort(id, input.forwardId ?? input.forward?.id ?? input.id);
    else if (input.action !== undefined && input.action !== 'list') throw new SshRemoteError('INVALID_REQUEST', 'ports action must be add, remove, or list.');
    return { ok: true, result, forwards: service.listPorts(id) };
  });
  route('/api/ssh-remote/diagnostics', ['POST'], async (request) => {
    const input = await body(request);
    return service.diagnostics(hostId(input));
  });

  route('/api/ssh-remote/local/plugins', ['POST'], async () => ({
    ok: true,
    bundles: await ctx.pluginManager.listBundles(),
  }));
  route('/api/ssh-remote/local/settings', ['POST'], async () => ({
    ok: true,
    descriptors: ctx.settings.describe({ redactSecrets: true }),
  }));

  ctx.effect(() => async () => {
    await service.close();
    await store.close();
  });
}
