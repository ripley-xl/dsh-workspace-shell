import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Guest entry (not `session-host`) is what a Guest Web Host loads; it is
// also the only place that publishes a card and the restart routes.
import { apply } from '../../packages/guest/index.js';
import { apply as applySessionHost } from '../../packages/guest/session-host/index.js';

const PORT = 61_595;

function request(body, { origin = `http://127.0.0.1:${PORT}`, host = `127.0.0.1:${PORT}` } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', host });
  if (origin !== null) headers.set('origin', origin);
  const payload = new TextEncoder().encode(body);
  let sent = false;
  return {
    headers,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: payload };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

/**
 * A Host context with just the services this plugin consumes. `profileName`
 * decides the environment gate exactly like the real loader-provided
 * `profileContext`.
 */
async function hostContext(profileName, root, applyFn = apply) {
  const home = path.join(root, 'home');
  const dir = path.join(root, `profile-${profileName}`);
  const store = path.join(root, 'session-store');
  const routes = new Map();
  const disposers = [];
  const webServer = { getOrigin: () => `http://127.0.0.1:${PORT}` };
  const agents = { get: () => false, list: () => [] };
  const jobs = { list: () => [] };
  const ctx = {
    profileContext: { name: profileName, dir, home, cwd: root },
    sessionPersistence: { identity: 'persistence-1' },
    loader: {
      entries: () => [{
        disabled: false,
        options: { name: '@deepseek-ai/dsh-session-persistence-jsonl' },
        fiber: { effectiveConfig: { root: store } },
        context: { get: () => ({ identity: 'persistence-1' }) },
      }],
    },
    agents,
    connection: {
      authenticatedUrl: (url) => `${url}?token=fake`,
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
    },
    webServer,
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    provide() {},
    on() { return () => {}; },
    get(name) {
      return { webServer, agents, jobs }[name];
    },
  };
  await applyFn(ctx);
  return {
    routes,
    async close() {
      for (const dispose of disposers.reverse()) {
        try { await dispose?.(); } catch { /* disposal is best effort */ }
      }
    },
  };
}

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'host-restart-supervised-'));
}

test('the Desktop app Host refuses to restart itself', async () => {
  const root = tempRoot();
  const previous = process.env.DSH_WORKSPACE_SUPERVISED;
  process.env.DSH_WORKSPACE_SUPERVISED = '0';
  const host = await hostContext('desktop', root);
  try {
    const status = await host.routes.get('/api/workspace-host/status').fetch(request('{}'));
    assert.equal(status.status, 200);
    const snapshot = await status.json();
    assert.equal(snapshot.supervised, true, 'the Desktop Host must never offer a self-restart');

    const response = await host.routes.get('/api/workspace-host/restart').fetch(request('{"mode":"now"}'));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, code: 'HOST_RESTART_SUPERVISED' });
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKSPACE_SUPERVISED;
    else process.env.DSH_WORKSPACE_SUPERVISED = previous;
    await host.close();
    // The Host-card disposer finishes asynchronously; retry the race away.
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('a Web profile Host is not supervised and accepts the same route shape', async () => {
  const root = tempRoot();
  // The runner's environment must not decide this: only the profile does.
  const previous = process.env.DSH_WORKSPACE_SUPERVISED;
  process.env.DSH_WORKSPACE_SUPERVISED = '0';
  const host = await hostContext('web', root);
  try {
    const status = await host.routes.get('/api/workspace-host/status').fetch(request('{}'));
    const snapshot = await status.json();
    assert.equal(snapshot.supervised, false);
    assert.equal(snapshot.allowRestart, true);
    // The action itself is exercised end-to-end elsewhere; here only the guard
    // must be out of the way, which is visible in the status snapshot.
    assert.equal(typeof host.routes.get('/api/workspace-host/restart').fetch, 'function');
  } finally {
    if (previous !== undefined) process.env.DSH_WORKSPACE_SUPERVISED = previous;
    await host.close();
    // The Host-card disposer finishes asynchronously; retry the race away.
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('a remote controller Host is supervised through its environment marker', async () => {
  const root = tempRoot();
  const previous = process.env.DSH_WORKSPACE_SUPERVISED;
  process.env.DSH_WORKSPACE_SUPERVISED = '1';
  const host = await hostContext('web', root);
  try {
    const status = await host.routes.get('/api/workspace-host/status').fetch(request('{}'));
    assert.equal((await status.json()).supervised, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKSPACE_SUPERVISED;
    else process.env.DSH_WORKSPACE_SUPERVISED = previous;
    await host.close();
    // The Host-card disposer finishes asynchronously; retry the race away.
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('the Desktop Shell reuse of session-host publishes no card and no restart routes', async () => {
  const root = tempRoot();
  const host = await hostContext('desktop', root, applySessionHost);
  try {
    assert.equal(host.routes.has('/api/workspace-host/status'), false, 'session-host must not serve Host lifecycle routes');
    assert.equal(host.routes.has('/api/workspace-host/restart'), false);
    let cards = [];
    try { cards = readdirSync(path.join(root, 'home', 'workspace-hosts')); } catch { cards = []; }
    assert.deepEqual(cards, [], 'a Desktop Host publishes no Web card');
  } finally {
    await host.close();
    // The Host-card disposer finishes asynchronously; retry the race away.
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('the restart route accepts the page origin of a forwarded port', async () => {
  const root = tempRoot();
  // A supervised Host refuses the action, so this proves the origin check
  // passed without dispatching a real restart.
  const host = await hostContext('desktop', root);
  try {
    // A remote Host reached through an SSH forward is served on another port
    // than its own authenticated URL; the browser's Origin and Host agree.
    const forwarded = request('{"mode":"now"}', { origin: 'http://127.0.0.1:61999', host: '127.0.0.1:61999' });
    const response = await host.routes.get('/api/workspace-host/restart').fetch(forwarded);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, code: 'HOST_RESTART_SUPERVISED' });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('the restart route rejects a cross-site or origin-less request', async () => {
  const root = tempRoot();
  const host = await hostContext('web', root);
  try {
    const crossSite = await host.routes.get('/api/workspace-host/restart').fetch(
      request('{"mode":"now"}', { origin: 'https://evil.example', host: `127.0.0.1:${PORT}` }),
    );
    assert.equal(crossSite.status, 403);
    assert.deepEqual(await crossSite.json(), { ok: false, code: 'HOST_RESTART_ORIGIN_REJECTED' });

    const noOrigin = await host.routes.get('/api/workspace-host/restart').fetch(request('{"mode":"now"}', { origin: null }));
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(await noOrigin.json(), { ok: false, code: 'HOST_RESTART_ORIGIN_REJECTED' });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
