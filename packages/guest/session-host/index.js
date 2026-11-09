import { createHash } from 'node:crypto';
import { createSessionHostRegistry, persistenceRoot, sessionIds, sessionHostError } from '../src/host/session-hosts.js';
import { createSessionViewBroker } from '../src/host/session-views.js';

export const inject = ['connection', 'profileContext', 'loader', 'agents', 'sessionPersistence'];

export async function readSessionHostInput(request) {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
  const reader = request.body?.getReader();
  if (!reader) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
    return input;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function apply(ctx) {
  const broker = createSessionViewBroker();
  ctx.effect(() => () => broker.dispose(), 'workspace session views');
  const webServer = ctx.get('webServer');
  // /tmp keeps Unix socket names below the platform limit even with long home paths.
  const scope = createHash('sha256').update(ctx.profileContext.home).digest('hex').slice(0, 16);
  const registry = await createSessionHostRegistry({
    directory: `/tmp/dsh-workspace-${process.getuid()}-${scope}`,
    storageRoot: persistenceRoot(ctx),
    profile: ctx.profileContext.name,
    owns: (id) => Boolean(ctx.agents.get(id)),
    attachUrl: webServer ? () => ctx.connection.authenticatedUrl(webServer.getOrigin() + '/') : undefined,
    views: (windowId) => broker.list(windowId),
    command: (viewId, command, signal) => broker.command(viewId, command, signal),
  });
  ctx.effect(() => () => registry.dispose(), 'workspace session Host registration');
  ctx.provide('workspaceSessionHosts', registry);
  const routes = {
    status: (input, signal) => registry.lookup(sessionIds(input.sessionIds), signal),
    attach: (input, signal) => registry.attach(input.instanceId, input.sessionId, signal),
    views: (input, signal) => registry.views(input.instanceId, input.windowId, signal),
    command: (input, signal) => registry.command(input.instanceId, input.viewId, input.command, signal),
    'view/update': (input) => ({ host: registry.describe(), ...broker.update(input) }),
    'view/ack': (input) => broker.acknowledge(input),
    'view/remove': (input) => { broker.remove(input.viewId); return { removed: true }; },
  };
  for (const [name, handle] of Object.entries(routes)) ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-session-hosts/' + name, methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      try {
        const input = await readSessionHostInput(request);
        const result = await handle(input, request.signal);
        return Response.json({ ok: true, result }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return Response.json({ ok: false, error: { code: error?.safe ? error.code : 'SESSION_HOST_UNAVAILABLE' } }, { status: 400, headers: { 'cache-control': 'no-store' } });
      }
    },
  }), 'workspace session ' + name);
}
