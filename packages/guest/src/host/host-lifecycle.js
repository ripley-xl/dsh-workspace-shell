// Guest-only Host lifecycle: publish who this Host is, and let it restart
// itself. This module must never be applied by the Desktop Shell — Desktop
// reuses `session-host/index.js` for cross-Host session discovery, but a
// Desktop Host has no business publishing a Web card or restarting itself.
// `packages/guest/index.js` is the only place that applies this module.

import { createRequire } from 'node:module';
import { createHostCard } from './host-card.js';
import { createHostRestart } from './host-restart.js';
import { inspectActiveTasks, inspectInstallLock } from './host-activity.js';
import { readSessionHostInput } from '../../session-host/index.js';

const GUEST_VERSION = (() => {
  try { return createRequire(import.meta.url)('../../package.json').version ?? null; } catch { return null; }
})();

const json = (status, payload) => Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });

/**
 * @param {object} ctx A Guest Web Host context. Nothing here is required by the
 * session routes, so every failure is silent rather than fatal.
 */
export async function applyHostLifecycle(ctx) {
  let webServer;
  try { webServer = ctx.get('webServer'); } catch { webServer = undefined; }
  const hostOrigin = (() => { try { return webServer ? new URL(webServer.getOrigin()) : null; } catch { return null; } })();
  const hostPort = hostOrigin ? Number(hostOrigin.port) : 0;
  const hostUrl = (() => {
    try { return hostOrigin ? ctx.connection.authenticatedUrl(hostOrigin.href.replace(/\/+$/u, '') + '/') : null; } catch { return null; }
  })();
  if (!hostOrigin || !Number.isInteger(hostPort) || hostPort < 1) return;

  // A Host may not restart itself when the remote controller owns it, or when
  // it is the Desktop app's Host. Desktop should never reach this module at
  // all; the profile check is a last line of defence, not the design.
  const supervised = process.env.DSH_WORKSPACE_SUPERVISED === '1'
    || ctx.profileContext.name === 'desktop';

  const restarts = createHostRestart({
    profileDir: ctx.profileContext.dir,
    identity: { pid: process.pid, port: hostPort, url: hostUrl, argv: process.argv, cwd: process.cwd() },
    busy: () => { const tasks = inspectActiveTasks(ctx); return { tasks: tasks.tasks, jobs: tasks.jobs }; },
  });
  ctx.effect(() => () => restarts.dispose(), 'workspace Host restart service');

  // Publish who this Host is. A Shell that did not spawn it (a different Shell,
  // a launcher, a restarted Host) reads the card to find and attach to it.
  ctx.effect(() => {
    let disposed = false;
    const ready = (async () => {
      try {
        const card = await createHostCard({
          home: ctx.profileContext.home,
          profile: ctx.profileContext.name,
          hostKey: process.env.DSH_WORKSPACE_HOST_KEY,
          port: hostPort,
          url: hostUrl,
          supervised,
          cwd: process.cwd(),
          argv: process.argv,
          guestVersion: GUEST_VERSION,
          dshVersion: typeof process.env.DSH_CLIENT_VERSION === 'string' ? process.env.DSH_CLIENT_VERSION : null,
        });
        if (disposed) {
          await card.dispose();
          return null;
        }
        return card;
      } catch {
        return null;
      }
    })();
    return () => {
      disposed = true;
      ready.then((card) => card?.dispose()).catch(() => {});
    };
  }, 'workspace Host card');

  // Status is readable with the page cookie alone; the restart action
  // additionally demands the same origin, so a page on another site cannot make
  // this Host kill itself. The page's origin is what the browser reports; behind
  // an SSH forward the page is reached on a different port than this Host's own
  // authenticated URL, so compare the Origin authority with the request's Host
  // authority instead of this process's origin.
  const sameOrigin = (request) => {
    const header = request.headers.get('origin');
    if (!header) return false;
    const host = request.headers.get('host');
    if (typeof host !== 'string' || host.length === 0) return false;
    try { return new URL(header).host === host; } catch { return false; }
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-host/status', methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      return json(200, { ok: true, supervised, ...restarts.status() });
    },
  }), 'workspace Host restart status');
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-host/restart', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      // Read the bounded body first: this is a streaming route, and a handler
      // that answers before consuming its body makes the connection layer
      // destroy the socket, so the page would see a network error instead of
      // the rejection code.
      let input;
      try { input = await readSessionHostInput(request); } catch { return json(400, { ok: false, code: 'HOST_RESTART_INVALID_INPUT' }); }
      if (!sameOrigin(request)) return json(403, { ok: false, code: 'HOST_RESTART_ORIGIN_REJECTED' });
      if (supervised) return json(403, { ok: false, code: 'HOST_RESTART_SUPERVISED' });
      const mode = input?.mode === 'wait' || input?.mode === 'cancel' ? input.mode : 'now';
      const lock = inspectInstallLock(ctx.profileContext.dir);
      if (lock.locked) return json(409, { ok: false, code: 'HOST_RESTART_INSTALLING' });
      try {
        return json(200, { ok: true, ...await restarts.restart({ mode, force: input?.force === true }) });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'HOST_RESTART_UNAVAILABLE';
        const status = code === 'HOST_RESTART_BUSY' || code === 'HOST_RESTART_COOLDOWN' ? 409 : code === 'HOST_RESTART_DISABLED' ? 403 : 503;
        return json(status, { ok: false, code });
      }
    },
  }), 'workspace Host restart action');
}
