import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createTabState } from '../../../packages/shell/src/tab-state.js';
import { createTabController } from '../../../packages/shell/src/tab-controller.js';
import { createWorkspaceClient } from '../../../packages/shell/src/workspace-client.js';
import { createWebTiming } from '../../../packages/shell/src/web-timing.js';
import { createTabOrderMemory } from '../../../packages/shell/src/tab-order.js';
import { createSshRequest } from '../../../packages/manager/src/client/workspace-extension.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const catalog = (extra = {}) => ({ currentProfile: 'home', defaultCwd: '/work', profiles: [
  { id: 'home', isCurrent: true, web: false, tui: true },
  { id: 'alpha', isCurrent: false, web: true, tui: true },
  { id: 'beta', isCurrent: false, web: true, tui: true },
], runtimes: [], ...extra });
const response = (payload, ok = true) => ({ response: true, payload, ok });
const tab = (client, id) => client.tabs.getSnapshot().tabs.find((item) => item.id === id);
const resource = (extra = {}) => ({ disposed: 0, visible: [], focused: 0, resized: 0,
  dispose() { this.disposed++; }, setVisible(value) { this.visible.push(value); }, focus() { this.focused++; }, resize() { this.resized++; }, ...extra,
});
class Events {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { for (const callback of [...(this.listeners.get(type) || [])]) callback(); }
}
const createGate = (supported = true) => {
  let sequence = 0;
  const gate = { supported, local: true, deferred: false, failNext: false, disposed: 0, calls: [],
    setLocal(local) {
      const request = ++sequence;
      const pending = deferred();
      const entry = { local, ...pending };
      gate.calls.push(entry);
      if (!gate.deferred) pending.resolve(!gate.failNext);
      gate.failNext = false;
      return pending.promise.then((accepted) => {
        if (!supported || gate.disposed || request !== sequence || !accepted) return false;
        gate.local = local;
        return true;
      });
    },
    dispose() {
      if (gate.disposed) return Promise.resolve();
      gate.disposed++;
      sequence++;
      gate.local = true;
      for (const call of gate.calls) call.resolve(false);
      return Promise.resolve();
    },
  };
  return gate;
};
const harness = (t, options = {}) => {
  const clock = { now: 0 };
  const window = new Events();
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  const storage = new Map(options.owner === undefined ? [] : [['workspace-shell.owner.v1', options.owner]]);
  window.sessionStorage = { getItem(key) { if (options.storageThrows) throw Error('storage'); return storage.get(key); }, setItem(key, value) { if (options.storageThrows) throw Error('storage'); storage.set(key, value); } };
  let uuids = 0;
  window.crypto = { randomUUID() { uuids++; return 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; } };
  const gate = createGate(options.gateSupported !== false);
  const shortcuts = { originalLayout: { panel: 'chat' }, marker: 'shortcuts-service' };
  const ctx = { get: (name) => name === 'shortcuts' ? shortcuts : undefined };
  const document = { marker: 'document', documentElement: { lang: 'en' } };
  const bridgeCalls = [];
  const bridge = {
    acquire(input) { bridgeCalls.push({ method: 'acquire', input }); return options.acquire ? options.acquire(input) : Promise.resolve({ lease: 'lease-' + bridgeCalls.length }); },
    release(input) { bridgeCalls.push({ method: 'release', input }); return Promise.resolve(); },
    onOpenRequested() { return () => {}; },
  };
  window.dshDesktop = options.native === false ? undefined : { browser: options.bridge || bridge };
  const calls = [];
  const handlers = { ...options.handlers };
  const fetcher = async (url, init) => {
    // GET routes carry no JSON body; POST routes do.
    const input = init?.body === undefined ? {} : JSON.parse(init.body);
    const path = url.replace('/api/workspace-shell', '');
    calls.push({ url, path, input, init });
    let result;
    if (handlers[path]) result = await handlers[path](input, init);
    else if (path === '/catalog') result = options.catalog || catalog();
    else if (path === '/web/open') result = { runtimeId: 'web-runtime-' + input.profileId, url: 'http://127.0.0.1:4567/app?token=secret#thread' };
    else if (path === '/web/attach') result = { runtimeId: input.runtimeId, url: 'http://127.0.0.1:4567/app?token=secret#thread' };
    else if (path === '/tui/open') result = { runtimeId: 'tui-runtime-' + input.profileId };
    else result = {};
    return result?.response ? { ok: result.ok, json: async () => result.payload } : { ok: true, json: async () => ({ ok: true, result }) };
  };
  window.fetch = fetcher;
  const guests = [];
  const createDesktopGuest = (input) => {
    let startPromise;
    let disposal;
    let lease;
    const guest = resource({ input, closed: false, starts: 0,
      ...(options.readWebCwd ? { cwdReads: 0, getWorkingDirectory() { this.cwdReads++; return options.readWebCwd(guest); } } : {}),
      start() {
        if (!startPromise) {
          guest.starts++;
          startPromise = Promise.resolve().then(() => input.bridge.acquire({ workspaceKey: input.workspaceKey })).then((value) => {
            lease = value.lease;
            if (!guest.closed && options.autoReady) input.onReady();
          });
        }
        return startPromise;
      },
      ready() { input.onReady(); },
      error(value) { input.onError(value); },
      dispose() {
        if (disposal) return disposal;
        guest.closed = true;
        guest.disposed++;
        disposal = Promise.resolve(startPromise).catch(() => {}).then(() => lease ? input.bridge.release({ lease }) : undefined);
        return disposal;
      },
    });
    guests.push(guest);
    return guest;
  };
  const tuiFactories = [];
  const tuis = [];
  const createTuiProvider = (factory) => {
    tuiFactories.push(factory);
    return { open(spec, lifecycle) {
      let disposal;
      let runtimeId;
      const terminal = resource({ spec, lifecycle, closed: false,
        dispose() {
          if (disposal) return disposal;
          terminal.closed = true; terminal.disposed++;
          disposal = task.catch(() => {}).then(() => runtimeId ? factory.api('/runtime/stop', { runtimeId, ownerId: factory.ownerId }) : undefined);
          return disposal;
        },
      });
      const task = Promise.resolve().then(() => factory.api('/tui/open', { profileId: spec.profileId, ownerId: factory.ownerId, cwd: spec.cwd, cols: 80, rows: 24, confirmIndependentHost: spec.confirmIndependentHost, ...(spec.command ? { command: spec.command } : {}) }, lifecycle.signal)).then((value) => { runtimeId = value.runtimeId; if (!terminal.closed) lifecycle.onReady(); }).catch(() => { if (!terminal.closed) lifecycle.onError('TUI_OPEN_FAILED'); });
      terminal.task = task;
      tuis.push(terminal);
      return terminal;
    } };
  };
  const client = createWorkspaceClient({ window, document, ctx, fetch: fetcher, createTabState, createTabController, isFrameActive: options.isFrameActive,
    installInputGate(service) { assert.equal(service, shortcuts); return gate; }, createDesktopGuest, createTuiProvider,
    createTabOrderMemory: options.createTabOrderMemory === false ? undefined : (options.createTabOrderMemory ?? createTabOrderMemory),
    ...(options.noTiming ? {} : { now: () => clock.now }),
    createWebTiming: options.noTiming ? undefined : (config) => createWebTiming({ limit: 8, now: () => clock.now }),
    createBrowserGuest: options.createBrowserGuest });
  let unmountAll = () => {};
  let removeSsh;
  if (options.ssh !== false) {
    const request = createSshRequest(fetcher);
    removeSsh = client.registerSshExtension({ request });
    void client.sshRequest('/status').catch(() => {});
  }
  const autoSurfaces = () => {
    const surfaces = new Map();
    const render = () => {
      const snapshot = client.tabs.getSnapshot();
      for (const [id, surface] of [...surfaces]) if (!snapshot.tabs.some((item) => item.id === id)) { surfaces.delete(id); surface.detach?.(); }
      for (const item of snapshot.tabs) {
        if (!item.closable) continue;
        const previous = surfaces.get(item.id);
        if (previous && previous.identity === item.identity) continue;
        previous?.detach?.();
        const surface = { identity: item.identity, container: previous?.container || {}, detach: null };
        surfaces.set(item.id, surface);
        surface.detach = client.tabs.mount(item.id, surface.container);
      }
    };
    const off = client.tabs.subscribe(render);
    render();
    unmountAll = off;
    return surfaces;
  };
  t.after(async () => { unmountAll(); await client.dispose(); });
  return { client, window, document, gate, storage, timers, calls, handlers, guests, tuis, tuiFactories, bridgeCalls, shortcuts, autoSurfaces, clock, removeSsh,
    get ownerId() { return calls.find((call) => call.path === '/catalog').input.ownerId; }, get uuids() { return uuids; },
    runTimer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => delay === undefined || timer.delay === delay);
      assert.ok(entry, `no timer with delay ${delay}`);
      timers.delete(entry[0]);
      entry[1].fn();
      return entry[1].delay;
    } };
};
const ofPath = (h, path) => h.calls.filter((call) => call.path === path);
const loaded = async (t, options) => { const h = harness(t, options); await flush(); assert.equal(h.client.info.getSnapshot().phase, 'ready'); return h; };
test('session navigation carries non-secret view identity through login redirect and retries only the original Host', async (t) => {
  const instanceId = 'a'.repeat(32), parent = 'b'.repeat(32), windowId = 'c'.repeat(32);
  const h = await loaded(t, { handlers: { '/api/workspace-session-hosts/attach': (input) => ({ host: { instanceId: input.instanceId }, sessionId: input.sessionId, url: 'http://127.0.0.1:4567/?token=secret' }) } });
  let count = 0;
  h.window.crypto.randomUUID = () => (++count).toString(16).padStart(32, '0');
  h.client.registerSessionNavigation({ context: async () => ({ instanceId: parent, windowId }) });
  h.autoSurfaces();
  const id = await h.client.openSessionHost({ instanceId, sessionId: 's', profile: 'home' });
  await flush();
  assert.notEqual(id, 'local');
  const url = new URL(h.guests[0].input.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get('workspaceSessionWindow'), windowId);
  assert.equal(fragment.get('workspaceSessionParent'), parent);
  assert.equal(fragment.get('workspaceShellEmbedded'), '1');
  assert.doesNotMatch(url.hash, /secret|token=/);
  const old = h.client.sessionTabs()[0];
  await h.client.retry(id); await flush();
  assert.notEqual(h.client.sessionTabs()[0].token, old.token);
  assert.notEqual(h.client.sessionTabs()[0].identity, old.identity);
  assert.equal(ofPath(h, '/web/open').length, 0);
  assert.deepEqual(ofPath(h, '/api/workspace-session-hosts/attach').map((call) => call.input), [{ instanceId, sessionId: 's' }, { instanceId, sessionId: 's' }]);
  assert.doesNotMatch(JSON.stringify(h.client.tabs.getSnapshot()), /secret|http:/);
});
const openWeb = async (h, profile = 'alpha') => { const id = await h.client.openWeb(profile, true); if (!h.guests.length) h.client.tabs.mount(id, {}); await flush(); return id; };
const generic = (h, providerId, kind = 'browser', implementation) => {
  const calls = [];
  const unregister = h.client.registerProvider(providerId, { kind, open(spec, lifecycle) { const value = implementation ? implementation(spec, lifecycle) : resource(); calls.push({ spec, lifecycle, value }); return value; } });
  return { calls, unregister, open: (key = 'shared', title = key) => h.client.open({ providerId, key, title }) };
};

test('without the SSH component startup and rejected SSH operations never contact its service', async (t) => {
  const h = await loaded(t, { ssh: false });
  assert.equal(h.calls.some((call) => call.url.includes('/ssh-remote')), false);
  await assert.rejects(h.client.sshRequest('/status'), { code: 'SSH_COMPONENT_DISABLED' });
  await assert.rejects(h.client.openSshWeb({ id: 'c1' }, 'http://127.0.0.1:1234/'), { code: 'SSH_COMPONENT_DISABLED' });
  assert.equal(h.client.sshExtension.getSnapshot(), null);
  await openWeb(h);
  assert.equal(h.guests.length, 1);
});
test('SSH unload retains tab identity and releases only SSH Guests; retry attaches the original instance', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const local = await openWeb(h);
  const id = await h.client.openSshWeb({ id: 'c1', name: 'dev-box', connected: true }, 'http://127.0.0.1:5678/?token=old', { instanceId: 'instance-1', profileId: 'web' });
  await flush();
  const before = tab(h.client, id);
  await h.removeSsh();
  assert.equal(tab(h.client, id).identity, before.identity);
  assert.equal(tab(h.client, id).error.code, 'SSH_COMPONENT_DISABLED');
  assert.equal(h.guests[1].disposed, 1);
  assert.equal(h.guests[0].disposed, 0);
  assert.ok(tab(h.client, local));
  assert.equal(h.client.getTabStatus(tab(h.client, id)).connected, false);
  await assert.rejects(h.client.retry(id), { code: 'SSH_COMPONENT_DISABLED' });
  const requests = [];
  h.client.registerSshExtension({ request: async (path, options) => {
    requests.push([path, options.body]);
    return { ok: true, instanceId: 'instance-1', url: 'http://127.0.0.1:9876/?token=new' };
  } });
  await h.client.retry(id); await flush();
  assert.deepEqual(requests, [['/web/attach', { hostId: 'c1', instanceId: 'instance-1' }]]);
  assert.match(h.guests[2].input.url, /9876/);
  assert.doesNotMatch(h.guests[2].input.url, /token=old/);
  assert.equal(h.calls.some((call) => /\/(?:stop|disconnect)$/.test(call.path)), false);
});
test('missing original instance leaves a retryable error and never opens a replacement', async (t) => {
  const h = await loaded(t); h.autoSurfaces();
  const id = await h.client.openSshWeb({ id: 'c1' }, 'http://127.0.0.1:5678/', { instanceId: 'instance-1' });
  await flush(); await h.removeSsh();
  const requests = [];
  h.client.registerSshExtension({ request: async (path) => { requests.push(path); throw Object.assign(new Error('unavailable'), { code: 'REMOTE_INSTANCE_UNAVAILABLE' }); } });
  await h.client.retry(id); await flush();
  assert.deepEqual(requests, ['/web/attach']);
  assert.equal(tab(h.client, id).error.code, 'REMOTE_INSTANCE_UNAVAILABLE');
  assert.equal(h.guests.length, 1);
});
test('a late request from the removed component cannot update the replacement connection state', async (t) => {
  const h = await loaded(t, { ssh: false });
  const pending = deferred();
  let signal;
  const remove = h.client.registerSshExtension({ request: (_path, options) => { signal = options.signal; return pending.promise; } });
  const request = h.client.sshRequest('/status');
  const rejected = assert.rejects(request, { code: 'SSH_COMPONENT_DISABLED' });
  await remove(); assert.equal(signal.aborted, true);
  const current = { request: async () => ({}), getSnapshot: () => ({ connections: [{ id: 'new', name: 'current', connected: true }] }) };
  h.client.registerSshExtension(current);
  pending.resolve({ connections: [{ id: 'old', name: 'stale', connected: true }] });
  await rejected; await remove();
  assert.equal(h.client.sshExtension.getSnapshot(), current);
  assert.deepEqual(h.client.connections.getSnapshot().map((item) => item.id), ['new']);
});
test('SSH conversion pending during unload keeps its record disabled without acquiring a late Guest', async (t) => {
  const h = await loaded(t); h.autoSurfaces();
  const id = await h.client.openLauncher();
  const off = h.client.tabs.subscribe(() => {
    if (tab(h.client, id)?.kind === 'profile-ui') { off(); void h.removeSsh(); }
  });
  await h.client.openSshWeb({ id: 'c1' }, 'http://127.0.0.1:5678/', { launcherId: id, instanceId: 'instance-1' });
  await flush();
  assert.equal(tab(h.client, id).error.code, 'SSH_COMPONENT_DISABLED');
  assert.equal(h.guests.length, 0);
});
test('workspace factory is import-free and composes injected real state/controller without runtime access at declaration', async () => {
  const source = await readFile(new URL('../../../packages/shell/src/workspace-client.js', import.meta.url), 'utf8');
  const script = source.replace(/^export /gm, '');
  assert.doesNotMatch(script, /^\s*(import|export)\s/m);
  assert.equal(typeof vm.runInNewContext(script + '\ncreateWorkspaceClient'), 'function');
});

test('startup catalog snapshots expose only allowlisted metadata, owner storage persists, and API unwraps result', async (t) => {
  const h = await loaded(t, { owner: 'saved-window', catalog: catalog({
    profiles: [{ id: 'home', isCurrent: true, web: false, tui: true, url: 'secret-url', token: 'secret-token' }],
    runtimes: [{ id: 'runtime-a', kind: 'web', profileId: 'home', phase: 'running', canStop: true, url: 'secret-url', token: 'secret-token', pid: 42 }],
    url: 'secret-url', token: 'secret-token',
  }) });
  assert.equal(h.ownerId, 'saved-window');
  assert.equal(h.uuids, 0);
  const snapshot = h.client.info.getSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['phase', 'currentProfile', 'defaultCwd', 'profiles', 'runtimes'].sort());
  assert.deepEqual(snapshot.profiles[0], { id: 'home', isCurrent: true, web: false, tui: true });
  assert.deepEqual(snapshot.runtimes[0], { id: 'runtime-a', kind: 'web', profileId: 'home', phase: 'running', canStop: true, source: 'local', views: 0 });
  assert.equal(Object.isFrozen(snapshot.profiles), true);
  assert.equal(Object.isFrozen(snapshot.runtimes[0]), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|token|url|pid/);
  const request = ofPath(h, '/catalog')[0];
  assert.deepEqual(request.input, { ownerId: 'saved-window' });
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(request.init.method, 'POST');
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
});

test('catalog keeps only known TUI flavors and branded tabs retain terminal kind', async (t) => {
  const h = await loaded(t, { catalog: catalog({ profiles: [
    { id: 'dsh', isCurrent: false, web: false, tui: true, tuiFlavor: 'dsh-tui', url: 'secret-url' },
    { id: 'pi', isCurrent: false, web: false, tui: true, tuiFlavor: 'pi-tui' },
    { id: 'legacy', isCurrent: false, web: false, tui: true },
    { id: 'invalid', isCurrent: false, web: false, tui: true, tuiFlavor: 'tianshu-tui' },
  ] }) });
  const profiles = h.client.info.getSnapshot().profiles;
  assert.equal(profiles.find((item) => item.id === 'dsh').tuiFlavor, 'dsh-tui');
  assert.equal(profiles.find((item) => item.id === 'pi').tuiFlavor, 'pi-tui');
  assert.equal(Object.hasOwn(profiles.find((item) => item.id === 'legacy'), 'tuiFlavor'), false);
  assert.equal(Object.hasOwn(profiles.find((item) => item.id === 'invalid'), 'tuiFlavor'), false);
  assert.doesNotMatch(JSON.stringify(profiles), /secret|url/);
  const first = await h.client.openTui('dsh', '/work', true);
  const second = await h.client.openTui('pi', '/work', true);
  assert.equal(tab(h.client, first).kind, 'terminal');
  assert.equal(tab(h.client, second).kind, 'terminal');
  assert.equal(tab(h.client, first).title, 'dsh · DSH TUI 1');
  assert.equal(tab(h.client, second).title, 'pi · Pi TUI 2');
});

test('invalid or inaccessible storage creates a safe window owner without failing initialization', async (t) => {
  const h = await loaded(t, { owner: 'invalid owner/token', storageThrows: true });
  assert.match(h.ownerId, /^window-[a-z0-9-]+$/);
  assert.equal(h.uuids, 1);
  assert.equal(ofPath(h, '/catalog')[0].input.ownerId, h.ownerId);
});

test('startup loads SSH sources without connecting them', async (t) => {
  const h = await loaded(t, { handlers: {
    '/api/ssh-remote/status': () => response({ ok: true, connections: [{ id: 'c1', name: 'anydev', phase: 'idle', autoConnect: false }] }),
  } });
  await flush();
  assert.equal(ofPath(h, '/api/ssh-remote/status').length, 1);
  assert.deepEqual(h.client.connections.getSnapshot(), [{ id: 'c1', name: 'anydev', connected: false }]);
  assert.equal(ofPath(h, '/api/ssh-remote/connect').length, 0);
});

test('older refresh results and older refresh failures cannot replace the latest catalog', async (t) => {
  const h = await loaded(t);
  const old = deferred();
  const latest = deferred();
  let count = 0;
  h.handlers['/catalog'] = () => ++count === 1 ? old.promise : latest.promise;
  const staleRefresh = h.client.refresh();
  const latestRefresh = h.client.refresh();
  latest.resolve(catalog({ defaultCwd: '/latest' }));
  assert.equal(await latestRefresh, true);
  const snapshot = h.client.info.getSnapshot();
  old.resolve(catalog({ defaultCwd: '/old' }));
  assert.equal(await staleRefresh, false);
  assert.equal(h.client.info.getSnapshot(), snapshot);
  const staleError = deferred();
  h.handlers['/catalog'] = () => staleError.promise;
  const failedOld = h.client.refresh();
  h.handlers['/catalog'] = () => catalog({ defaultCwd: '/newest' });
  await h.client.refresh();
  staleError.reject(Error('old secret failure'));
  assert.equal(await failedOld, false);
  assert.equal(h.client.info.getSnapshot().defaultCwd, '/newest');
  assert.equal(h.client.info.getSnapshot().phase, 'ready');
});

test('current refresh failure retains useful catalog metadata and exposes only a safe error code', async (t) => {
  const h = await loaded(t);
  h.handlers['/catalog'] = () => response({ ok: false, error: { code: 'CATALOG_DENIED', message: 'secret-token' } }, false);
  assert.equal(await h.client.refresh(), false);
  assert.equal(h.client.info.getSnapshot().phase, 'error');
  assert.equal(h.client.info.getSnapshot().currentProfile, 'home');
  assert.equal(h.client.info.getSnapshot().errorCode, 'CATALOG_DENIED');
  assert.doesNotMatch(JSON.stringify(h.client.info.getSnapshot()), /secret-token/);
  h.handlers['/catalog'] = () => catalog();
  await h.client.refresh();
  assert.equal(h.client.info.getSnapshot().phase, 'ready');
  assert.equal(Object.hasOwn(h.client.info.getSnapshot(), 'errorCode'), false);
});

test('missing Native bridge does not register local-web and unknown providers never reserve a tab', async (t) => {
  const h = await loaded(t, { native: false });
  assert.equal(h.client.canWeb, false);
  assert.equal(h.client.canTui, true);
  const initial = h.client.tabs.getSnapshot();
  await assert.rejects(h.client.openWeb('alpha', true), { code: 'TAB_PROVIDER_UNAVAILABLE' });
  await assert.rejects(h.client.open({ providerId: 'missing', key: 'x', title: 'X' }), { code: 'TAB_PROVIDER_UNAVAILABLE' });
  assert.equal(h.client.tabs.getSnapshot(), initial);
  assert.equal(ofPath(h, '/web/open').length, 0);
  assert.equal(h.guests.length, 0);
  assert.equal(h.gate.calls.length, 0);
});

test('unsupported input gate preserves Local and closeViews without changing the original layout', async (t) => {
  const h = await loaded(t, { gateSupported: false });
  const original = h.shortcuts.originalLayout;
  assert.equal(h.client.canWeb, false);
  assert.equal(h.client.canTui, false);
  assert.equal(await h.client.activate('local'), true);
  assert.equal(await h.client.openWeb('home'), 'local');
  await h.client.closeViews();
  assert.equal(h.shortcuts.originalLayout, original);
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
  assert.equal(h.guests.length, 0);
  assert.equal(h.tuiFactories.length, 0);
});

test('current profile remains Local even when its catalog web capability is false', async (t) => {
  const h = await loaded(t);
  assert.equal(await h.client.openWeb('home'), 'local');
  assert.equal(await h.client.open({ providerId: 'local-web', profileId: 'home', key: 'home-alias', title: 'Home' }), 'local');
  assert.equal(h.guests.length, 0);
  assert.equal(ofPath(h, '/web/open').length, 0);
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
  assert.throws(() => h.client.openWeb('not-authorized', true), { code: 'PROFILE_NOT_FOUND' });
});

test('multiple providers of the same kind coexist and deduplicate only within their provider ID', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const a = generic(h, 'extension-a');
  const b = generic(h, 'extension-b');
  const one = await a.open();
  const two = await b.open();
  assert.notEqual(one, two);
  assert.equal(await a.open(), one);
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 3);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(a.calls[0].spec.providerId, 'extension-a');
  assert.equal(b.calls[0].spec.providerId, 'extension-b');
  await a.unregister();
  assert.equal(tab(h.client, one), undefined);
  assert.ok(tab(h.client, two));
  assert.equal(a.calls[0].value.disposed, 1);
  assert.equal(b.calls[0].value.disposed, 0);
});

test('authenticated view URLs reach only the Guest, preserve hash, and add the embedded query', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await openWeb(h);
  assert.equal(await h.client.readDefaultCwd(id, '/unused-local'), null, 'a Guest without the scalar companion has no cwd default');
  assert.equal(h.guests.length, 1);
  const guest = h.guests[0];
  const url = new URL(guest.input.url);
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.get('workspaceShellEmbedded'), '1');
  assert.equal(url.hash, '#thread');
  assert.match(guest.input.workspaceKey, /^workspace-profile:local-web:alpha:web:/);
  assert.doesNotMatch(JSON.stringify(h.client.tabs.getSnapshot()), /token|secret|http|runtimeId|lease/);
  assert.equal(tab(h.client, id).phase, 'opening');
  guest.ready();
  await flush();
  assert.equal(tab(h.client, id).phase, 'ready');
  assert.deepEqual([...h.timers.values()].map((timer) => timer.delay).filter((delay) => delay !== 300), []);
  assert.equal(guest.focused, 0);
});

test('ordinary activation keeps Guest handles and Host Web processes rather than reopening', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const a = await openWeb(h, 'alpha');
  const b = await openWeb(h, 'beta');
  assert.equal(h.guests.length, 2);
  for (const id of [a, 'local', b, a, b, 'local']) assert.equal(await h.client.activate(id), true);
  assert.equal(h.guests.length, 2);
  assert.equal(ofPath(h, '/web/open').length, 2);
  assert.equal(h.guests.every((guest) => guest.disposed === 0 && guest.focused === 0), true);
  assert.equal(h.gate.local, true);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
});

test('closing Web releases its Guest lease once without stopping the Host Web runtime', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await openWeb(h);
  assert.equal(await h.client.close(id), true);
  assert.equal(tab(h.client, id), undefined);
  assert.equal(h.guests[0].disposed, 1);
  assert.equal(h.bridgeCalls.filter((call) => call.method === 'release').length, 1);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
  assert.equal(h.gate.local, true);
});

test('closing a pending Web request aborts it and never creates a Guest from a late response', async (t) => {
  const pending = deferred();
  t.after(() => pending.resolve({ view: { url: 'http://127.0.0.1:7777/?token=late' } }));
  const h = await loaded(t, { handlers: { '/web/open': () => pending.promise } });
  h.autoSurfaces();
  const id = await h.client.openWeb('alpha', true);
  await flush();
  const closing = h.client.close(id);
  await flush();
  assert.equal(ofPath(h, '/web/open')[0].init.signal.aborted, true);
  assert.equal(tab(h.client, id), undefined);
  pending.resolve({ view: { url: 'http://127.0.0.1:7777/?token=late' } });
  assert.equal(await closing, true);
  assert.equal(h.guests.length, 0);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
});

test('late Guest acquisition is released after close and late ready cannot focus or resurrect the tab', async (t) => {
  const acquire = deferred();
  t.after(() => acquire.resolve({ lease: 'late-lease' }));
  const h = await loaded(t, { acquire: () => acquire.promise });
  h.autoSurfaces();
  const id = await openWeb(h);
  const guest = h.guests[0];
  const closing = h.client.close(id);
  await flush();
  guest.ready();
  acquire.resolve({ lease: 'late-lease' });
  await closing;
  guest.ready();
  await flush();
  assert.equal(tab(h.client, id), undefined);
  assert.equal(guest.focused, 0);
  assert.equal(guest.disposed, 1);
  assert.equal(h.bridgeCalls.filter((call) => call.method === 'release').length, 1);
});

test('Guest readiness timeout changes the tab to safe error and releases the lease', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await openWeb(h);
  assert.equal(h.runTimer(30000), 30000);
  await flush();
  assert.equal(tab(h.client, id).phase, 'error');
  assert.deepEqual(tab(h.client, id).error, { code: 'WORKSPACE_VIEW_TIMEOUT' });
  assert.equal(h.guests[0].disposed, 1);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.delay).filter((delay) => delay !== 300), []);
  h.guests[0].ready();
  await flush();
  assert.equal(tab(h.client, id).phase, 'error');
  assert.equal(h.guests[0].focused, 0);
});

test('TUI receives the shared owner and unwrapped API and stops only its terminal runtime on close', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await h.client.openTui('alpha', '/terminal-work', true);
  await flush();
  assert.equal(h.tuiFactories.length, 1);
  assert.equal(h.tuiFactories[0].ownerId, h.ownerId);
  assert.equal(ofPath(h, '/tui/open')[0].input.ownerId, h.ownerId);
  assert.equal(ofPath(h, '/tui/open')[0].input.cwd, '/terminal-work');
  assert.equal(tab(h.client, id).phase, 'ready');
  assert.doesNotMatch(JSON.stringify(h.client.tabs.getSnapshot()), /tui-runtime|ownerId/);
  await h.client.close(id);
  assert.equal(h.tuis[0].closed, true);
  assert.equal(h.tuis[0].disposed, 1);
  assert.deepEqual(ofPath(h, '/runtime/stop')[0].input, { runtimeId: 'tui-runtime-alpha', ownerId: h.ownerId });
});

test('default cwd reads the active TUI launch value and never substitutes Local or catalog cwd', async (t) => {
  const h = await loaded(t);
  const first = await h.client.openTui('alpha', '/launch-one', true);
  const second = await h.client.openTui('alpha', '/launch-two', true);
  assert.equal(await h.client.readDefaultCwd(first, '/local'), null, 'an inactive TUI cannot supply the default');
  assert.equal(await h.client.readDefaultCwd(second, '/local'), '/launch-two');
  await h.client.activate(first);
  assert.equal(await h.client.readDefaultCwd(first, '/local'), '/launch-one');
  await h.client.activate('local');
  assert.equal(await h.client.readDefaultCwd('local', '/effective-local'), '/effective-local');
  assert.equal(await h.client.readDefaultCwd('local', ''), null);
  assert.equal(await h.client.readDefaultCwd(first, '/local'), null);
  assert.notEqual(await h.client.readDefaultCwd('local', null), h.client.info.getSnapshot().defaultCwd);
});

test('Web cwd reads are scoped to the active tab and invalidate on generation replacement', async (t) => {
  let implementation = () => '/web-effective';
  const h = await loaded(t, { readWebCwd: () => implementation() });
  h.autoSurfaces();
  const id = await openWeb(h);
  assert.equal(await h.client.readDefaultCwd(id, '/local'), '/web-effective');
  const switched = deferred();
  implementation = () => switched.promise;
  const staleSwitch = h.client.readDefaultCwd(id, '/local');
  await h.client.activate('local');
  switched.resolve('/after-switch');
  assert.equal(await staleSwitch, null);
  await h.client.activate(id);
  const replaced = deferred();
  implementation = () => replaced.promise;
  const staleGeneration = h.client.readDefaultCwd(id, '/local');
  assert.equal(await h.client.retry(id), true);
  await flush();
  replaced.resolve('/old-generation');
  assert.equal(await staleGeneration, null);
  implementation = () => '/new-generation';
  assert.equal(await h.client.readDefaultCwd(id, '/local'), '/new-generation');
  await h.client.close(id);
  assert.equal(await h.client.readDefaultCwd(id, '/local'), null);
});

test('normal TUI exit closes its tab, restores input, and never closes another profile view', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await h.client.openTui('alpha', '/work', true);
  await flush();
  assert.equal(h.tuis[0].lifecycle.onExit(), true);
  await flush(); await flush();
  assert.equal(tab(h.client, id), undefined);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true);
  assert.deepEqual(ofPath(h, '/runtime/stop').map((call) => call.input.runtimeId), ['tui-runtime-alpha']);
  assert.equal(h.tuis[0].lifecycle.onExit(), false);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
  const background = await loaded(t);
  background.autoSurfaces();
  const terminal = await background.client.openTui('alpha', '/work', true);
  const web = await openWeb(background, 'beta');
  await flush();
  background.tuis[0].lifecycle.onExit();
  await flush(); await flush();
  assert.equal(tab(background.client, terminal), undefined);
  assert.equal(background.client.tabs.getSnapshot().activeId, web);
  assert.equal(background.gate.local, false);
  assert.equal(background.guests[0].disposed, 0);
  assert.deepEqual(ofPath(background, '/runtime/stop').map((call) => call.input.runtimeId), ['tui-runtime-alpha']);
});

test('same-profile Web views use independent Guest leases and closing one preserves the shared Host', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await openWeb(h, 'alpha');
  const second = await openWeb(h, 'alpha');
  assert.notEqual(first, second);
  assert.equal(h.guests.length, 2);
  assert.notEqual(h.guests[0].input.workspaceKey, h.guests[1].input.workspaceKey);
  assert.equal(ofPath(h, '/web/open').length, 2);
  await h.client.close(first);
  assert.equal(h.guests[0].disposed, 1);
  assert.equal(h.guests[1].disposed, 0);
  assert.ok(tab(h.client, second));
  assert.equal(h.client.tabs.getSnapshot().activeId, second);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
});

test('stopping a Web Host closes every associated view and preserves other profiles', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await openWeb(h, 'alpha');
  const second = await openWeb(h, 'alpha');
  const other = await openWeb(h, 'beta');
  await h.client.activate(second);
  await h.client.stopRuntime('web-runtime-alpha');
  assert.equal(tab(h.client, first), undefined);
  assert.equal(tab(h.client, second), undefined);
  assert.ok(tab(h.client, other));
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true);
  assert.deepEqual(h.guests.map((guest) => guest.disposed), [1, 1, 0]);
  assert.deepEqual(ofPath(h, '/runtime/stop').map((call) => call.input.runtimeId), ['web-runtime-alpha']);
});

test('a failed Web Host stop leaves its views intact', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await openWeb(h, 'alpha');
  const second = await openWeb(h, 'alpha');
  h.handlers['/runtime/stop'] = () => response({ ok: false, error: { code: 'STOP_FAILED' } }, false);
  await assert.rejects(h.client.stopRuntime('web-runtime-alpha'), { code: 'STOP_FAILED' });
  assert.ok(tab(h.client, first));
  assert.ok(tab(h.client, second));
  assert.deepEqual(h.guests.map((guest) => guest.disposed), [0, 0]);
});

test('stopping a starting Web Host closes its pending view by profile', async (t) => {
  const h = await loaded(t, {
    catalog: catalog({ runtimes: [{ id: 'web-starting', kind: 'web', profileId: 'alpha', phase: 'starting', canStop: true }] }),
    handlers: { '/web/open': (_input, init) => new Promise((resolve) => {
      init.signal.addEventListener('abort', () => resolve({ runtimeId: 'web-starting', url: 'http://127.0.0.1:4567/' }), { once: true });
    }) },
  });
  h.autoSurfaces();
  const id = await h.client.openWeb('alpha', true);
  await flush();
  await h.client.stopRuntime('web-starting');
  assert.equal(tab(h.client, id), undefined);
  assert.equal(h.guests.length, 0);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
});

test('same-profile TUI instances accept equal or different cwd and close or exit independently', async (t) => {
  let opened = 0;
  const h = await loaded(t, { handlers: { '/tui/open': () => ({ runtimeId: `tui-runtime-alpha-${++opened}` }) } });
  h.autoSurfaces();
  const first = await h.client.openTui('alpha', '/same', true);
  const second = await h.client.openTui('alpha', '/same', true);
  const third = await h.client.openTui('alpha', '/other', true);
  await flush();
  assert.equal(new Set([first, second, third]).size, 3);
  assert.equal(new Set([tab(h.client, first).title, tab(h.client, second).title, tab(h.client, third).title]).size, 3);
  assert.deepEqual(ofPath(h, '/tui/open').map((call) => call.input.cwd), ['/same', '/same', '/other']);
  await h.client.close(second);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
  assert.equal(ofPath(h, '/runtime/stop')[0].input.runtimeId, 'tui-runtime-alpha-2');
  assert.ok(tab(h.client, first)); assert.ok(tab(h.client, third));
  assert.equal(h.tuis[0].disposed, 0); assert.equal(h.tuis[2].disposed, 0);
  h.tuis[2].lifecycle.onExit();
  await flush(); await flush();
  assert.equal(tab(h.client, third), undefined);
  assert.ok(tab(h.client, first));
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(ofPath(h, '/runtime/stop').map((call) => call.input.runtimeId).includes('tui-runtime-alpha-1'), false);
});

test('latest gated activation wins and stale gated opens never reserve a placeholder', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'custom');
  const id = await extension.open('a');
  h.gate.deferred = true;
  const toLocal = h.client.activate('local');
  const first = h.gate.calls.at(-1);
  const back = h.client.activate(id);
  const second = h.gate.calls.at(-1);
  second.resolve(true);
  assert.equal(await back, true);
  first.resolve(true);
  assert.equal(await toLocal, false);
  assert.equal(h.client.tabs.getSnapshot().activeId, id);
  assert.equal(h.gate.local, false);
  const stale = extension.open('never-created');
  const old = h.gate.calls.at(-1);
  const latest = h.client.activate('local');
  const current = h.gate.calls.at(-1);
  current.resolve(true);
  assert.equal(await latest, true);
  old.resolve(true);
  await assert.rejects(stale, { code: 'WORKSPACE_INPUT_GATE_FAILED' });
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 2);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true);
  h.gate.deferred = false;
});

test('provider removed during gate await rejects opening without creating a tab', async (t) => {
  const h = await loaded(t);
  const extension = generic(h, 'temporary');
  h.gate.deferred = true;
  const pending = extension.open();
  const gate = h.gate.calls.at(-1);
  await extension.unregister();
  h.gate.deferred = false;
  gate.resolve(true);
  await assert.rejects(pending, { code: 'TAB_PROVIDER_UNAVAILABLE' });
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
  assert.equal(extension.calls.length, 0);
  assert.equal(h.gate.local, true);
});

test('removing a provider while opening it must not restore Local input over a different active provider', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const active = generic(h, 'still-active');
  const activeId = await active.open();
  const removed = generic(h, 'removed');
  h.gate.deferred = true;
  const pending = removed.open();
  const gate = h.gate.calls.at(-1);
  await removed.unregister();
  h.gate.deferred = false;
  gate.resolve(true);
  await assert.rejects(pending, { code: 'TAB_PROVIDER_UNAVAILABLE' });
  assert.equal(h.client.tabs.getSnapshot().activeId, activeId);
  assert.equal(h.gate.local, false, 'Native Local shortcuts must remain gated while another remote surface is active');
});

test('provider removal inside synchronous reserve notification closes its pending Surface before acquisition', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'remove-in-reserve');
  const off = h.client.tabs.subscribe(() => {
    if (h.client.tabs.getSnapshot().tabs.some((item) => item.key.startsWith('remove-in-reserve:'))) { off(); extension.unregister(); }
  });
  assert.equal(await extension.open(), null);
  await flush();
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
  assert.equal(extension.calls.length, 0);
  assert.equal(h.gate.local, true);
});

test('provider removal aborts acquisition and releases its late handle without touching another provider', async (t) => {
  const pending = deferred();
  const late = resource();
  t.after(() => pending.resolve(late));
  const h = await loaded(t);
  h.autoSurfaces();
  const removed = generic(h, 'late-provider', 'browser', () => pending.promise);
  const kept = generic(h, 'kept-provider');
  const id = await removed.open();
  const keptId = await kept.open();
  await removed.unregister();
  assert.equal(tab(h.client, id), undefined);
  assert.equal(removed.calls[0].lifecycle.signal.aborted, true);
  assert.ok(tab(h.client, keptId));
  pending.resolve(late);
  await flush();
  assert.equal(late.disposed, 1);
  assert.equal(kept.calls[0].value.disposed, 0);
});

test('automatic Surface detach selects Local and restores the native input gate', async (t) => {
  const h = await loaded(t);
  const surfaces = h.autoSurfaces();
  const extension = generic(h, 'surface');
  const id = await extension.open();
  assert.equal(h.gate.local, false);
  await surfaces.get(id).detach();
  await flush();
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true);
  assert.equal(extension.calls[0].value.disposed, 1);
});

test('dispose restores native input, cleans every mounted handle, and removes pagehide listeners', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await openWeb(h);
  const terminal = await h.client.openTui('beta', '/work', true);
  await flush();
  assert.ok(tab(h.client, terminal));
  const failing = generic(h, 'throwing-cleanup', 'browser', () => resource({ dispose() { this.disposed++; throw Error('cleanup'); } }));
  await failing.open();
  assert.equal(h.window.listeners.get('pagehide').size, 1);
  const first = h.client.dispose();
  assert.equal(h.client.dispose(), first);
  await first;
  assert.equal(h.guests[0].disposed, 1);
  assert.equal(h.tuis[0].disposed, 1);
  assert.equal(failing.calls[0].value.disposed, 1);
  assert.equal(h.gate.disposed, 1);
  assert.equal(h.gate.local, true);
  assert.equal(h.window.listeners.get('pagehide').size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(ofPath(h, '/catalog')[0].init.signal.aborted, true);
  const count = h.calls.length;
  h.window.emit('pagehide');
  await flush();
  assert.equal(h.calls.length, count);
});

test('activation whose target is removed during gate await restores the still-active Local input mode', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'removed-target');
  const id = await extension.open();
  await h.client.activate('local');
  h.gate.deferred = true;
  const activation = h.client.activate(id);
  const pending = h.gate.calls.at(-1);
  await extension.unregister();
  h.gate.deferred = false;
  pending.resolve(true);
  assert.equal(await activation, false);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true, 'a removed target must not leave Local shortcuts disabled');
});

test('a superseded auto-Surface input restore does not publish a false gate failure over a newer remote activation', async (t) => {
  const h = await loaded(t);
  const surfaces = h.autoSurfaces();
  const extension = generic(h, 'surface-race');
  const first = await extension.open('first');
  h.gate.deferred = true;
  await surfaces.get(first).detach();
  const restore = h.gate.calls.at(-1);
  assert.equal(restore.local, true);
  const opening = extension.open('second');
  const latest = h.gate.calls.at(-1);
  latest.resolve(true);
  const second = await opening;
  h.gate.deferred = false;
  restore.resolve(true);
  await flush();
  assert.equal(h.client.tabs.getSnapshot().activeId, second);
  assert.equal(h.gate.local, false);
  assert.equal(h.client.info.getSnapshot().errorCode, undefined, 'superseded gate acknowledgement is cancellation, not failure');
});

test('retry follows generation Surface effects and replaces only its Guest after releasing the old lease', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await openWeb(h);
  h.guests[0].ready();
  await flush();
  const identity = tab(h.client, id).identity;
  assert.equal(await h.client.retry(id), true);
  await flush();
  assert.equal(h.guests.length, 2);
  assert.equal(h.guests[0].disposed, 1);
  assert.notEqual(tab(h.client, id).identity, identity);
  assert.equal(typeof tab(h.client, id).generation, 'undefined', 'numeric generation stays private');
  assert.equal(tab(h.client, id).phase, 'opening');
  assert.equal(h.guests[1].disposed, 0);
  h.guests[1].ready();
  await flush();
  assert.equal(tab(h.client, id).phase, 'ready');
  assert.equal(h.guests[1].focused, 0);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
});

test('closeViews returns to Local, releases all Guests, and stops terminal runtimes only', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await openWeb(h, 'alpha');
  await openWeb(h, 'beta');
  await h.client.openTui('alpha', '/work', true);
  await flush();
  const layout = h.shortcuts.originalLayout;
  await h.client.closeViews();
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
  assert.equal(h.gate.local, true);
  assert.equal(h.shortcuts.originalLayout, layout);
  assert.deepEqual(h.guests.map((guest) => guest.disposed), [1, 1]);
  assert.equal(h.tuis[0].disposed, 1);
  assert.deepEqual(ofPath(h, '/runtime/stop').map((call) => call.input.runtimeId), ['tui-runtime-alpha']);
});

test('failed input gate acknowledgement keeps the active view intact rather than closing it unsafely', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'gate-failure');
  const id = await extension.open();
  h.gate.failNext = true;
  await assert.rejects(h.client.close(id), { code: 'WORKSPACE_INPUT_GATE_FAILED' });
  assert.equal(h.client.tabs.getSnapshot().activeId, id);
  assert.equal(extension.calls[0].value.disposed, 0);
  assert.equal(h.gate.local, false);
});

test('a Guest that becomes ready after switching to Local stays hidden and never steals focus', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await openWeb(h);
  await h.client.activate('local');
  h.guests[0].ready();
  await flush();
  assert.equal(tab(h.client, id).phase, 'ready');
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.guests[0].visible.at(-1), false);
  assert.equal(h.guests[0].focused, 0);
  assert.equal(h.gate.local, true);
});

test('non-loopback and credential-bearing Web URLs are rejected without creating a Guest', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const urls = ['http://external.example:1234/?token=secret', 'http://user:pass@127.0.0.1:1234/', 'https://127.0.0.1:1234/'];
  for (let index = 0; index < urls.length; index++) {
    h.handlers['/web/open'] = () => ({ url: urls[index] });
    const id = await h.client.open({ providerId: 'local-web', key: 'invalid-' + index, title: 'Invalid URL', profileId: 'alpha' });
    await flush();
    assert.equal(tab(h.client, id).phase, 'error');
    assert.deepEqual(tab(h.client, id).error, { code: 'WORKSPACE_INVALID_WEB_URL' });
    assert.equal(h.guests.length, 0);
    await h.client.close(id);
  }
});

test('a refresh completing after dispose cannot publish or restart any resource', async (t) => {
  const h = await loaded(t);
  const pending = deferred();
  h.handlers['/catalog'] = () => pending.promise;
  const refresh = h.client.refresh();
  const snapshot = h.client.info.getSnapshot();
  let notifications = 0;
  h.client.info.subscribe(() => { notifications++; });
  await h.client.dispose();
  pending.resolve(catalog({ defaultCwd: '/too-late' }));
  assert.equal(await refresh, false);
  assert.equal(h.client.info.getSnapshot(), snapshot);
  assert.equal(notifications, 0);
  assert.equal(h.gate.disposed, 1);
});

test('incomplete Native bridge capabilities never register local-web', async (t) => {
  for (const missing of ['acquire', 'release', 'onOpenRequested']) {
    const bridge = { acquire() {}, release() {}, onOpenRequested() {} };
    delete bridge[missing];
    const h = await loaded(t, { bridge });
    assert.equal(h.client.canWeb, false);
    await assert.rejects(h.client.openWeb('alpha', true), { code: 'TAB_PROVIDER_UNAVAILABLE' });
    assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
    assert.equal(ofPath(h, '/web/open').length, 0);
  }
});

test('provider registration validates IDs and duplicate IDs while old revocation cannot remove a replacement', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  assert.throws(() => h.client.registerProvider('invalid:id', { kind: 'browser', open() {} }), { code: 'WORKSPACE_INVALID_PROVIDER' });
  const previous = generic(h, 'replaceable');
  assert.throws(() => generic(h, 'replaceable'), { code: 'TAB_PROVIDER_REGISTERED' });
  const first = previous.unregister();
  assert.equal(previous.unregister(), first);
  await first;
  const replacement = generic(h, 'replaceable');
  const id = await replacement.open();
  await previous.unregister();
  assert.ok(tab(h.client, id));
  assert.equal(replacement.calls.length, 1);
  assert.equal(replacement.calls[0].value.disposed, 0);
});

test('invalid catalog and unsafe transport errors become safe public failures without inventing profiles', async (t) => {
  const h = harness(t, { handlers: { '/catalog': () => ({ currentProfile: 'home', profiles: {}, runtimes: [] }) } });
  await flush();
  assert.equal(h.client.info.getSnapshot().phase, 'error');
  assert.equal(h.client.info.getSnapshot().errorCode, 'WORKSPACE_INVALID_CATALOG');
  assert.equal(h.client.info.getSnapshot().profiles.length, 0);
  h.handlers['/catalog'] = () => response({ ok: false, error: { code: 'https://host/?token=secret', message: 'secret' } }, false);
  await h.client.refresh();
  assert.equal(h.client.info.getSnapshot().errorCode, 'WORKSPACE_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(h.client.info.getSnapshot()), /https|token|secret/);
  h.handlers['/catalog'] = () => { throw Error('network-secret'); };
  await h.client.refresh();
  assert.equal(h.client.info.getSnapshot().errorCode, 'WORKSPACE_UNREACHABLE');
  assert.equal(h.client.tabs.getSnapshot().tabs.length, 1);
});

test('info subscriber failure cannot prevent other subscribers or valid catalog refresh', async (t) => {
  const h = await loaded(t);
  let calls = 0;
  const offBad = h.client.info.subscribe(() => { throw Error('observer'); });
  const offGood = h.client.info.subscribe(() => { calls++; });
  await h.client.refresh();
  assert.equal(calls, 1);
  assert.equal(h.client.info.getSnapshot().phase, 'ready');
  offBad(); offGood(); offGood();
  await h.client.refresh();
  assert.equal(calls, 1);
});

test('Original or conflicting Frame blocks new remote tabs while Local and closeViews remain usable', async (t) => {
  const h = await loaded(t, { isFrameActive: () => false });
  const extension = generic(h, 'original-blocked');
  const initial = h.client.tabs.getSnapshot();
  await assert.rejects(extension.open(), { code: 'WORKSPACE_FRAME_INACTIVE' });
  await assert.rejects(h.client.openWeb('alpha', true), { code: 'WORKSPACE_FRAME_INACTIVE' });
  await assert.rejects(h.client.openTui('alpha', '/work', true), { code: 'WORKSPACE_FRAME_INACTIVE' });
  assert.equal(await h.client.activate('local'), true);
  assert.equal(await h.client.openWeb('home'), 'local');
  await h.client.closeViews();
  assert.equal(h.client.tabs.getSnapshot(), initial);
  assert.equal(extension.calls.length, 0);
  assert.equal(h.guests.length, 0);
  assert.equal(h.tuis.length, 0);
  assert.equal(h.gate.calls.some((call) => call.local === false), false);
});

test('switching to Original blocks activation and retry of existing remote tabs but allows their cleanup', async (t) => {
  let frameActive = true;
  const h = await loaded(t, { isFrameActive: () => frameActive });
  h.autoSurfaces();
  const extension = generic(h, 'frame-transition');
  const id = await extension.open();
  await h.client.activate('local');
  const identity = tab(h.client, id).identity;
  frameActive = false;
  assert.equal(await h.client.activate(id), false);
  assert.equal(await h.client.retry(id), false);
  assert.equal(tab(h.client, id).identity, identity);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, true);
  await h.client.closeViews();
  assert.equal(tab(h.client, id), undefined);
  assert.equal(extension.calls[0].value.disposed, 1);
});

test('opening an overlay above Local disables Local shortcuts and closing it restores them', async (t) => {
  const h = await loaded(t);
  const snapshot = h.client.tabs.getSnapshot();
  assert.equal(await h.client.setOverlay(true), true);
  assert.equal(h.gate.local, false);
  assert.equal(h.client.tabs.getSnapshot(), snapshot);
  assert.equal(await h.client.setOverlay(false), true);
  assert.equal(h.gate.local, true);
  assert.equal(h.client.tabs.getSnapshot(), snapshot);
  assert.deepEqual(h.gate.calls.map((call) => call.local), [false, true]);
});

test('opening and closing an overlay above a remote tab never enables Local shortcuts or reopens the surface', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'remote-overlay');
  const id = await extension.open();
  const before = h.gate.calls.length;
  assert.equal(await h.client.setOverlay(true), true);
  assert.equal(h.gate.local, false);
  assert.equal(await h.client.setOverlay(false), true);
  assert.equal(h.gate.local, false);
  assert.deepEqual(h.gate.calls.slice(before).map((call) => call.local), [false, false]);
  assert.equal(h.client.tabs.getSnapshot().activeId, id);
  assert.equal(extension.calls.length, 1);
  assert.equal(extension.calls[0].value.disposed, 0);
  assert.equal(extension.calls[0].value.focused, 0);
});

test('activating Local while an overlay is open keeps shortcuts disabled until the overlay closes', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const extension = generic(h, 'overlay-local-switch');
  await extension.open();
  await h.client.setOverlay(true);
  assert.equal(await h.client.activate('local'), true);
  assert.equal(h.client.tabs.getSnapshot().activeId, 'local');
  assert.equal(h.gate.local, false);
  assert.equal(h.gate.calls.at(-1).local, false);
  assert.equal(await h.client.setOverlay(false), true);
  assert.equal(h.gate.local, true);
  assert.equal(extension.calls[0].value.disposed, 0);
});

test('latest overlay and navigation requests win without reporting obsolete gate acknowledgements as errors', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  h.gate.deferred = true;
  const opening = h.client.setOverlay(true);
  const old = h.gate.calls.at(-1);
  const closing = h.client.setOverlay(false);
  const latest = h.gate.calls.at(-1);
  latest.resolve(true);
  assert.equal(await closing, true);
  old.resolve(true);
  assert.equal(await opening, false);
  assert.equal(h.gate.local, true);
  assert.equal(h.client.info.getSnapshot().errorCode, undefined);
  const extension = generic(h, 'overlay-navigation');
  const staleOverlay = h.client.setOverlay(true);
  const staleGate = h.gate.calls.at(-1);
  const remote = extension.open();
  const remoteGate = h.gate.calls.at(-1);
  remoteGate.resolve(true);
  const id = await remote;
  staleGate.resolve(true);
  assert.equal(await staleOverlay, false);
  assert.equal(h.client.tabs.getSnapshot().activeId, id);
  assert.equal(h.gate.local, false);
  assert.equal(h.client.info.getSnapshot().errorCode, undefined);
  h.gate.deferred = false;
  assert.equal(await h.client.setOverlay(false), true);
  assert.equal(h.gate.local, false);
});

test('Local-only and Web-only documents with copied owner storage never adopt catalog terminals for pagehide cleanup', async (t) => {
  const h = await loaded(t, { owner: 'copied-owner', catalog: catalog({ runtimes: [
    { id: 'other-document-terminal', kind: 'tui', profileId: 'alpha', phase: 'running', canStop: true },
  ] }) });
  assert.equal(h.ownerId, 'copied-owner');
  const nonOrderCalls = () => h.calls.filter((call) => call.path !== '/tab-order/set').length;
  const initial = nonOrderCalls();
  h.window.emit('pagehide');
  await flush();
  assert.equal(nonOrderCalls(), initial);
  h.autoSurfaces();
  await openWeb(h);
  const afterWeb = nonOrderCalls();
  h.window.emit('pagehide');
  await flush();
  assert.equal(nonOrderCalls(), afterWeb);
  assert.equal(ofPath(h, '/runtime/close-owner').length, 0);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
  assert.equal(h.client.info.getSnapshot().runtimes[0].id, 'other-document-terminal');
});

test('two documents sharing the same owner request cleanup only for their own successfully opened terminals', async (t) => {
  const shared = catalog({ runtimes: [
    { id: 'terminal-document-a', kind: 'tui', profileId: 'alpha', phase: 'running', canStop: true },
    { id: 'terminal-document-b', kind: 'tui', profileId: 'alpha', phase: 'running', canStop: true },
  ] });
  const a = await loaded(t, { owner: 'copied-owner', catalog: shared, handlers: { '/tui/open': () => ({ runtimeId: 'terminal-document-a' }) } });
  const b = await loaded(t, { owner: 'copied-owner', catalog: shared, handlers: { '/tui/open': () => ({ runtimeId: 'terminal-document-b' }) } });
  a.autoSurfaces(); b.autoSurfaces();
  assert.equal(a.ownerId, b.ownerId);
  const beforeA = ofPath(a, '/catalog').length;
  const beforeB = ofPath(b, '/catalog').length;
  await a.client.openTui('alpha', '/work-a', true);
  await b.client.openTui('alpha', '/work-b', true);
  await flush();
  assert.equal(ofPath(a, '/catalog').length, beforeA + 1, 'successful TUI acquisition refreshes the catalog');
  assert.equal(ofPath(b, '/catalog').length, beforeB + 1);
  a.window.emit('pagehide');
  await flush();
  assert.deepEqual(ofPath(a, '/runtime/close-owner').map((call) => call.input), [{ ownerId: 'copied-owner', runtimeIds: ['terminal-document-a'] }]);
  assert.equal(ofPath(b, '/runtime/close-owner').length, 0);
  assert.equal(ofPath(b, '/runtime/stop').length, 0);
  b.window.emit('pagehide');
  await flush();
  assert.deepEqual(ofPath(b, '/runtime/close-owner').map((call) => call.input), [{ ownerId: 'copied-owner', runtimeIds: ['terminal-document-b'] }]);
  assert.equal(ofPath(a, '/runtime/stop').length, 0);
});

test('normally closing the final TUI removes document ownership so pagehide does not request cleanup again', async (t) => {
  const h = await loaded(t, { owner: 'copied-owner' });
  h.autoSurfaces();
  const id = await h.client.openTui('alpha', '/work', true);
  await flush();
  assert.equal(await h.client.close(id), true);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
  assert.deepEqual(ofPath(h, '/runtime/stop')[0].input, { runtimeId: 'tui-runtime-alpha', ownerId: 'copied-owner' });
  await flush();
  const before = h.calls.filter((call) => call.path !== '/tab-order/set').length;
  h.window.emit('pagehide');
  await flush();
  assert.equal(h.calls.filter((call) => call.path !== '/tab-order/set').length, before);
  assert.equal(ofPath(h, '/runtime/close-owner').length, 0);
});

test('failed terminal stop retains document ownership for best-effort pagehide cleanup', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await h.client.openTui('alpha', '/work', true);
  await flush();
  h.handlers['/runtime/stop'] = () => response({ ok: false, error: { code: 'STOP_FAILED' } }, false);
  await assert.rejects(h.client.stopRuntime('tui-runtime-alpha'), { code: 'STOP_FAILED' });
  h.window.emit('pagehide');
  await flush();
  assert.deepEqual(ofPath(h, '/runtime/close-owner')[0].input, { ownerId: h.ownerId, runtimeIds: ['tui-runtime-alpha'] });
});

test('pagehide sends only document-owned terminal cleanup with keepalive and never stops Web runtimes', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await openWeb(h);
  await h.client.openTui('beta', '/work', true);
  await flush();
  const before = h.calls.length;
  h.window.emit('pagehide');
  await flush();
  const requests = h.calls.slice(before);
  const order = requests.filter((call) => call.path === '/tab-order/set');
  assert.equal(order.length, 1, 'a dirty tab order is flushed once on pagehide');
  assert.equal(order[0].init.keepalive, true);
  const cleanup = requests.filter((call) => call.path !== '/tab-order/set');
  assert.deepEqual(cleanup.map((call) => call.path), ['/runtime/close-owner']);
  assert.deepEqual(cleanup[0].input, { ownerId: h.ownerId, runtimeIds: ['tui-runtime-beta'] });
  assert.equal(cleanup[0].init.keepalive, true);
  assert.equal(cleanup[0].init.credentials, 'same-origin');
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
  assert.equal(h.guests[0].disposed, 0);
});

// --- remembered tab order ---------------------------------------------------

test('a remembered order survives a fresh Client and places reverse opens back in order', async (t) => {
  const stored = ['local', 'tui:beta', 'web:alpha'];
  const handlers = {
    '/tab-order/get': () => ({ order: [...stored] }),
    '/tab-order/set': (input) => { stored.splice(0, stored.length, ...input.order); return { saved: true }; },
  };
  const first = await loaded(t, { handlers });
  first.autoSurfaces();
  const web = await openWeb(first, 'alpha');
  const tui = await first.client.openTui('beta', '/work', true);
  await flush();
  assert.deepEqual(first.client.tabs.getSnapshot().tabs.map((tab) => tab.id), ['local', tui, web]);

  const second = await loaded(t, { handlers });
  second.autoSurfaces();
  const web2 = await openWeb(second, 'alpha');
  const tui2 = await second.client.openTui('beta', '/work', true);
  await flush();
  assert.deepEqual(second.client.tabs.getSnapshot().tabs.map((tab) => tab.id), ['local', tui2, web2]);
});

test('a workspace opened while the remembered order loads keeps its identity', async (t) => {
  const pending = deferred();
  const saved = [];
  const h = harness(t, { handlers: {
    '/tab-order/get': () => pending.promise,
    '/tab-order/set': (input) => { saved.push([...input.order]); return { saved: true }; },
  } });
  h.autoSurfaces();
  const web = await h.client.open({ providerId: 'local-web', profileId: 'alpha', key: 'alpha:web:pre', title: 'alpha · Web' });
  await flush();
  assert.equal(h.client.tabs.getSnapshot().tabs.some((tab) => tab.id === web), true, 'opening is not blocked by the order read');
  pending.resolve({ order: ['local', 'tui:beta'] });
  await flush();
  assert.equal(h.client.info.getSnapshot().phase, 'ready');
  assert.equal(h.runTimer(300), 300);
  await flush();
  assert.deepEqual(saved[saved.length - 1].includes('web:alpha'), true, 'the in-flight workspace is folded back into the order');
});

test('a drag is remembered once after the debounce window', async (t) => {
  const saved = [];
  const h = await loaded(t, { handlers: { '/tab-order/set': (input) => { saved.push([...input.order]); return { saved: true }; } } });
  h.autoSurfaces();
  const web = await openWeb(h, 'alpha');
  const tui = await h.client.openTui('beta', '/work', true);
  await flush();
  assert.deepEqual(saved, [], 'nothing is written before the debounce window elapses');
  assert.equal(h.client.moveTab(tui, 0), true);
  assert.equal(h.client.moveTab(web, 0), true);
  assert.equal([...h.timers.values()].filter((timer) => timer.delay === 300).length, 1, 'live moves coalesce into one save');
  assert.equal(h.runTimer(300), 300);
  await flush();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], ['web:alpha', 'tui:beta', 'local']);
});

test('a closed tab returns to its remembered slot when reopened', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const web = await openWeb(h, 'alpha');
  const tui = await h.client.openTui('beta', '/work', true);
  await flush();
  assert.equal(h.client.moveTab(web, 0), true);
  assert.equal(await h.client.close(web), true);
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), ['local', tui]);
  const again = await openWeb(h, 'alpha');
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), [again, 'local', tui]);
});

test('unavailable or rejecting tab-order storage leaves tabs and dragging usable', async (t) => {
  const h = await loaded(t, { handlers: {
    '/tab-order/get': () => response({ ok: false, error: { code: 'WORKSPACE_REQUEST_FAILED' } }, false),
    '/tab-order/set': () => response({ ok: false, error: { code: 'WORKSPACE_REQUEST_FAILED' } }, false),
  } });
  h.autoSurfaces();
  const web = await openWeb(h, 'alpha');
  const tui = await h.client.openTui('beta', '/work', true);
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), ['local', web, tui]);
  assert.equal(h.client.moveTab(tui, 0), true);
  assert.equal(h.runTimer(300), 300);
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), [tui, 'local', web]);
  assert.equal(ofPath(h, '/tab-order/get').length, 1, 'the order is read once per Client');
  assert.equal(ofPath(h, '/tab-order/set').length, 1);
});

test('launchers are not remembered and an in-place conversion keeps its slot', async (t) => {
  const saved = [];
  const h = await loaded(t, { handlers: { '/tab-order/set': (input) => { saved.push([...input.order]); return { saved: true }; } } });
  h.autoSurfaces();
  const web = await openWeb(h, 'alpha');
  const tui = await h.client.openTui('beta', '/work', true);
  await flush();
  assert.equal(h.client.moveTab(web, 0), true);
  const launcher = await h.client.openLauncher();
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), [web, 'local', tui, launcher]);
  await h.client.openLauncherWeb(launcher, { profileId: 'beta' });
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((tab) => tab.id), [web, 'local', tui, launcher]);
  assert.equal(h.runTimer(300), 300);
  await flush();
  assert.deepEqual(saved[saved.length - 1], ['web:alpha', 'local', 'tui:beta', 'web:beta']);
});

test('dispose clears a pending remembered-order save', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await openWeb(h, 'alpha');
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 300), true);
  await h.client.dispose();
  assert.equal(h.timers.size, 0);
});

// --- launcher, in-place conversion, attach, SSH and measurement --------------

test('opening a launcher reserves one metadata tab and records the source identity', async (t) => {
  const h = await loaded(t);
  const id = await h.client.openLauncher();
  const record = tab(h.client, id);
  assert.equal(record.kind, 'launcher');
  assert.equal(record.key.startsWith('launcher:'), true);
  assert.equal(h.client.tabs.getSnapshot().activeId, id);
  assert.deepEqual(h.client.launcherSource(id), { kind: 'profile-ui', tabId: 'local' });
  assert.equal(ofPath(h, '/web/open').length, 0, 'no Host work happens for a launcher');
  assert.equal(h.client.info.getSnapshot().phase, 'ready');
  assert.equal(ofPath(h, '/catalog').length, 1, 'opening a launcher performs no extra catalog request');
  assert.equal(await h.client.close(id), true);
  assert.equal(tab(h.client, id), undefined);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
});

test('launcher tabs close without Host or input side effects', async (t) => {
  const h = await loaded(t);
  const id = await h.client.openLauncher();
  assert.equal(h.gate.local, false);
  assert.equal(await h.client.close(id), true);
  assert.equal(h.gate.local, true);
  assert.equal(h.guests.length, 0);
  assert.equal(h.tuis.length, 0);
});

test('opening a launcher from a Web tab records that tab and only returns its cwd while the record is current', async (t) => {
  const h = await loaded(t, { readWebCwd: () => '/web-cwd' });
  h.autoSurfaces();
  const web = await openWeb(h);
  h.guests[0].ready();
  await flush();
  const launcher = await h.client.openLauncher();
  assert.deepEqual(h.client.launcherSource(launcher), { kind: 'profile-ui', tabId: web });
  assert.equal(await h.client.readLauncherCwd(launcher, '/local'), '/web-cwd');
  await h.client.close(launcher);
  assert.equal(await h.client.readLauncherCwd(launcher, '/local'), null, 'a closed launcher never resolves a cwd');
});

test('launcher conversion keeps the tab id, position and active state and starts the target provider', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await h.client.openLauncher();
  const second = await h.client.openLauncher();
  assert.equal(h.client.tabs.getSnapshot().activeId, second);
  const before = tab(h.client, first);
  h.gate.deferred = false;
  const converted = await h.client.openLauncherWeb(first, { profileId: 'alpha' });
  assert.equal(converted, first);
  const after = tab(h.client, first);
  assert.equal(after.kind, 'profile-ui');
  assert.notEqual(after.identity, before.identity, 'conversion allocates a fresh identity');
  assert.equal(h.client.tabs.getSnapshot().tabs.findIndex((item) => item.id === first), 1, 'position is preserved');
  assert.equal(h.client.tabs.getSnapshot().activeId, second, 'active state is unchanged');
  assert.deepEqual(h.client.launcherSource(first), null, 'the launcher provenance is retired');
  await flush();
  assert.equal(h.guests.length, 1);
  const open = ofPath(h, '/web/open');
  assert.equal(open.length, 1);
  assert.equal(open[0].input.profileId, 'alpha');
});

test('a stale launcher conversion never mutates the converted record', async (t) => {
  const h = await loaded(t);
  const id = await h.client.openLauncher();
  await h.client.close(id);
  await assert.rejects(h.client.openLauncherWeb(id, { profileId: 'alpha' }), { code: 'WORKSPACE_LAUNCHER_STALE' });
  assert.equal(tab(h.client, id), undefined);
});

test('a late callback from the pre-conversion launcher run cannot touch the converted tab', async (t) => {
  const h = await loaded(t);
  const surfaces = h.autoSurfaces();
  const id = await h.client.openLauncher();
  const launcherDetach = surfaces.get(id).detach;
  await h.client.openLauncherWeb(id, { profileId: 'alpha' });
  assert.equal(await launcherDetach(), false, 'the pre-conversion detach is already stale');
  const record = tab(h.client, id);
  assert.ok(record);
  assert.equal(record.kind, 'profile-ui', 'detaching the launcher mount must not close the converted tab');
  await flush();
  assert.equal(h.guests.length, 1);
});

test('conversion to TUI records the launch cwd for later defaults', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await h.client.openLauncher();
  assert.equal(await h.client.openLauncherTui(id, { profileId: 'alpha', cwd: '/launcher-cwd', command: 'dsh --profile alpha' }), id);
  await flush();
  assert.equal(tab(h.client, id).kind, 'terminal');
  assert.equal(await h.client.readDefaultCwd(id, '/local'), '/launcher-cwd');
  assert.equal(ofPath(h, '/tui/open')[0].input.command, 'dsh --profile alpha');
});

test('a running same-owner Web Host is attached by runtime id instead of starting another Host', async (t) => {
  const h = await loaded(t, { catalog: catalog({ runtimes: [{ id: 'runtime-a', kind: 'web', profileId: 'alpha', phase: 'running', canStop: true }] }) });
  h.autoSurfaces();
  const launcher = await h.client.openLauncher();
  await h.client.openLauncherWeb(launcher, { profileId: 'alpha', runtimeId: 'runtime-a' });
  await flush();
  assert.equal(ofPath(h, '/web/open').length, 0, 'attach never starts a Host');
  assert.deepEqual(ofPath(h, '/web/attach')[0].input, { runtimeId: 'runtime-a', ownerId: h.ownerId });
  assert.equal(h.guests.length, 1);
});

test('attach rejects starting, stopping, foreign-owned and SSH runtimes before any request', async (t) => {
  const h = await loaded(t, { catalog: catalog({ runtimes: [
    { id: 'starting', kind: 'web', profileId: 'alpha', phase: 'starting', canStop: true },
    { id: 'stopping', kind: 'web', profileId: 'alpha', phase: 'stopping', canStop: true },
    { id: 'other', kind: 'web', profileId: 'alpha', phase: 'running', canStop: false },
    { id: 'remote', kind: 'web', profileId: 'alpha', phase: 'running', canStop: true, source: 'ssh' },
  ] }) });
  const launcher = await h.client.openLauncher();
  for (const runtimeId of ['starting', 'stopping', 'other', 'remote', 'missing']) {
    await assert.rejects(h.client.openLauncherWeb(launcher, { profileId: 'alpha', runtimeId }), { code: 'RUNTIME_NOT_ACTIVE' });
  }
  assert.equal(ofPath(h, '/web/attach').length, 0);
  assert.equal(h.guests.length, 0);
});

test('Host view counts follow opened and closed Web tabs without another catalog request', async (t) => {
  const h = await loaded(t, { catalog: catalog({ runtimes: [{ id: 'runtime-a', kind: 'web', profileId: 'alpha', phase: 'running', canStop: true }] }) });
  h.autoSurfaces();
  assert.equal(h.client.info.getSnapshot().runtimes[0].views, 0);
  const id = await h.client.open({ providerId: 'local-web', key: 'alpha:view', title: 'View', profileId: 'alpha', runtimeId: 'runtime-a' });
  await flush();
  assert.equal(h.client.info.getSnapshot().runtimes[0].views, 1);
  assert.equal(h.client.info.getSnapshot().runtimes[0].source, 'local');
  await h.client.close(id);
  await flush();
  assert.equal(h.client.info.getSnapshot().runtimes[0].views, 0);
});

test('SSH views open an authorized loopback URL and expose only connection status', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await h.client.openSshWeb({ id: 'c1', name: 'dev-box', connected: true }, 'http://127.0.0.1:49152/?tkn=secret&workspaceShellEmbedded=1');
  await flush();
  assert.ok(tab(h.client, id));
  assert.equal(h.guests.length, 1);
  assert.equal(new URL(h.guests[0].input.url).searchParams.get('tkn'), 'secret');
  assert.equal(new URL(h.guests[0].input.url).searchParams.get('workspaceShellEmbedded'), '1');
  const status = h.client.getTabStatus(tab(h.client, id));
  assert.deepEqual(status, { source: 'ssh', alias: 'dev-box', name: 'dev-box', connected: true, label: 'dev-box · Web 1' });
  assert.doesNotMatch(JSON.stringify(h.client.tabs.getSnapshot()), /http|tkn|secret/);
  assert.doesNotMatch(JSON.stringify(h.client.connections.getSnapshot()), /http|tkn|secret/);
});

test('SSH tabs are remembered by host and profile and keep their private URLs out of the order', async (t) => {
  const saved = [];
  const h = await loaded(t, { handlers: {
    '/tab-order/get': () => ({ order: ['local', 'ssh:c1:web', 'ssh:c2:web'] }),
    '/tab-order/set': (input) => { saved.push([...input.order]); return { saved: true }; },
  } });
  h.autoSurfaces();
  const second = await h.client.openSshWeb({ id: 'c2', name: 'other', connected: true }, 'http://127.0.0.1:49153/?tkn=secret', { profileId: 'web' });
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((item) => item.id), ['local', second]);
  const first = await h.client.openSshWeb({ id: 'c1', name: 'dev-box', connected: true }, 'http://127.0.0.1:49152/?tkn=secret');
  await flush();
  assert.deepEqual(h.client.tabs.getSnapshot().tabs.map((item) => item.id), ['local', first, second], 'the lower-ranked host wins the remembered slot');
  assert.equal(h.client.moveTab(first, 2), true);
  assert.equal(h.runTimer(300), 300);
  await flush();
  assert.deepEqual(saved[saved.length - 1], ['local', 'ssh:c2:web', 'ssh:c1:web']);
  assert.doesNotMatch(JSON.stringify(saved), /http|127\.0\.0\.1|tkn|secret/);
  assert.doesNotMatch(JSON.stringify(h.client.tabs.getSnapshot()), /http|tkn|secret/);
});

test('SSH status reports grey when the connection drops and keeps the last known name', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const id = await h.client.openSshWeb({ id: 'c1', name: 'dev-box', connected: true }, 'http://127.0.0.1:49152/');
  h.client.reportSsh({ connections: [{ id: 'c1', name: 'dev-box', phase: 'reconnecting' }] });
  const status = h.client.getTabStatus(tab(h.client, id));
  assert.equal(status.connected, false);
  assert.equal(status.alias, 'dev-box');
  assert.deepEqual(h.client.connections.getSnapshot().map((entry) => entry.id), ['c1']);
});

test('SSH request routes only allowlisted paths through the same-origin API and never leak bodies', async (t) => {
  const h = await loaded(t);
  h.handlers['/api/ssh-remote/status'] = () => response({ ok: true, connections: [{ id: 'c1', name: 'dev-box', phase: 'connected' }] });
  const payload = await h.client.sshRequest('/status');
  assert.equal(payload.ok, true);
  const request = h.calls.find((call) => call.url === '/api/ssh-remote/status');
  assert.ok(request);
  assert.equal(request.init.credentials, 'same-origin');
  assert.deepEqual(h.client.connections.getSnapshot(), [{ id: 'c1', name: 'dev-box', connected: true }]);
  await assert.rejects(h.client.sshRequest('/../secrets'), { code: 'WORKSPACE_INVALID_REQUEST' });
  await assert.rejects(h.client.sshRequest('http://evil.example/status'), { code: 'WORKSPACE_INVALID_REQUEST' });
  h.handlers['/api/ssh-remote/status'] = () => response({ ok: false, error: { code: 'AUTH_DENIED', message: 'private-token' } }, false);
  await assert.rejects(h.client.sshRequest('/status'), { code: 'AUTH_DENIED' });
});

test('SSH close all views for one host keeps other connections and their views', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/');
  const second = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/');
  const other = await h.client.openSshWeb({ id: 'c2', name: 'beta' }, 'http://127.0.0.1:49152/');
  assert.equal(await h.client.closeSshViews('c1'), 2);
  assert.equal(tab(h.client, first), undefined);
  assert.equal(tab(h.client, second), undefined);
  assert.ok(tab(h.client, other));
  assert.equal(await h.client.closeSshViews('missing'), 0);
});

test('non-loopback or credential-bearing SSH URLs are rejected before a tab exists', async (t) => {
  const h = await loaded(t);
  const before = h.client.tabs.getSnapshot();
  for (const url of ['http://external.example:1234/', 'http://user:pass@127.0.0.1:1234/', 'https://127.0.0.1:1234/', 'http://127.0.0.1/']) {
    await assert.rejects(h.client.openSshWeb({ id: 'c1', name: 'dev-box' }, url), { code: 'WORKSPACE_INVALID_WEB_URL' });
  }
  assert.equal(h.client.tabs.getSnapshot(), before);
  assert.equal(h.guests.length, 0);
});

test('Web measurements record stages, totals and reuse without exposing private data', async (t) => {
  const h = await loaded(t, { catalog: catalog({ runtimes: [{ id: 'runtime-a', kind: 'web', profileId: 'alpha', phase: 'running', canStop: true }] }) });
  h.autoSurfaces();
  h.clock.now = 0;
  const id = await h.client.openWeb('alpha', true);
  await flush();
  h.clock.now = 120;
  h.guests[0].ready();
  await flush();
  const entries = h.client.timing.getSnapshot().entries;
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.status, 'ready');
  assert.equal(entry.reused, false);
  assert.equal(entry.profile, 'alpha');
  assert.equal(entry.totalMs, 120);
  assert.deepEqual(entry.stages.map((stage) => stage.stage), ['input', 'host', 'lease', 'load']);
  assert.doesNotMatch(JSON.stringify(entries), /http|token|runtime/);
  assert.ok(tab(h.client, id));
});

test('attach measurements are marked reused and a newer measurement of the same view wins', async (t) => {
  const h = await loaded(t, { catalog: catalog({ runtimes: [{ id: 'runtime-a', kind: 'web', profileId: 'alpha', phase: 'running', canStop: true }] }) });
  h.autoSurfaces();
  const first = await h.client.open({ providerId: 'local-web', key: 'alpha:view', title: 'View', profileId: 'alpha', runtimeId: 'runtime-a' });
  await flush();
  h.guests[0].ready();
  await flush();
  assert.equal(h.client.timing.getSnapshot().entries[0].reused, true);
  const stale = h.client.timing.begin({ key: 'local-web:' + 'alpha:view', source: 'local', profile: 'alpha', reused: false });
  await h.client.retry(first);
  await flush();
  h.guests[0].ready();
  await flush();
  assert.equal(stale.finish(), false, 'a superseded measurement cannot publish');
  assert.ok(h.client.timing.getSnapshot().entries.every((entry) => entry.reused !== false || entry.id > stale.id - 1));
});

test('closing a pending view cancels the measurement and never creates a late Guest', async (t) => {
  const pending = deferred();
  const h = await loaded(t, { handlers: { '/web/open': () => pending.promise } });
  h.autoSurfaces();
  const id = await h.client.openWeb('alpha', true);
  await flush();
  const closing = h.client.close(id);
  await flush();
  assert.equal(ofPath(h, '/web/open')[0].init.signal.aborted, true);
  pending.resolve({ runtimeId: 'late', url: 'http://127.0.0.1:4567/' });
  assert.equal(await closing, true);
  await flush();
  assert.equal(h.guests.length, 0, 'a late URL never creates a Guest');
  assert.equal(h.client.timing.getSnapshot().entries.length, 0, 'a cancelled open is not recorded as a measurement');
});

test('measurements are bounded and never contain more than the configured entries', async (t) => {
  const h = await loaded(t);
  for (let index = 0; index < 12; index++) {
    const token = h.client.timing.begin({ key: 'local-web:key-' + index, source: 'local', profile: 'alpha' });
    token.mark('input'); token.finish();
  }
  assert.equal(h.client.timing.getSnapshot().entries.length, 8);
});

test('browser Guest is used when no Native bridge exists and receives the parent origin', async (t) => {
  const guests = [];
  const createBrowserGuest = (input) => {
    const guest = resource({ input, closed: false, starts: 0,
      start() { guest.starts++; return Promise.resolve().then(() => input.onReady()); },
      dispose() { guest.closed = true; guest.disposed++; return Promise.resolve(); },
    });
    guests.push(guest);
    return guest;
  };
  const h = await loaded(t, { native: false, createBrowserGuest });
  assert.equal(h.client.canWeb, true, 'a browser Guest makes Web available without the Native bridge');
  h.autoSurfaces();
  const id = await h.client.openWeb('alpha', true);
  await flush();
  assert.equal(guests.length, 1);
  assert.equal(guests[0].input.parentOrigin, undefined, 'no window.location.origin in the harness, so no origin is claimed');
  assert.equal(tab(h.client, id).phase, 'ready');
  assert.equal(ofPath(h, '/web/open').length, 1);
});

test('Native bridge is preferred over the browser Guest when both are available', async (t) => {
  const guests = [];
  const createBrowserGuest = () => { guests.push(1); return resource(); };
  const h = await loaded(t, { createBrowserGuest });
  h.autoSurfaces();
  await h.client.openWeb('alpha', true);
  await flush();
  assert.equal(guests.length, 0, 'Desktop guests stay the first choice');
  assert.equal(h.guests.length, 1);
});

test('launcher moveTab returns false for unknown targets without touching state', async (t) => {
  const h = await loaded(t);
  const launcher = await h.client.openLauncher();
  const before = h.client.tabs.getSnapshot();
  assert.equal(h.client.moveTab('missing', 0), false);
  assert.equal(h.client.moveTab(launcher, 99), false);
  assert.equal(h.client.tabs.getSnapshot(), before);
  assert.equal(h.client.moveTab(launcher, 0), true);
});

test('dispose retires measurements and pending launchers', async (t) => {
  const h = await loaded(t);
  await h.client.openLauncher();
  h.client.timing.begin({ key: 'local-web:pending', source: 'local', profile: 'alpha' });
  await h.client.dispose();
  assert.deepEqual(h.client.timing.getSnapshot().entries, []);
  assert.deepEqual(h.client.connections.getSnapshot(), []);
});

test('SSH view counts are keyed by host and profile and follow closed views', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'web' });
  await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'web' });
  await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'other' });
  assert.deepEqual(h.client.sshViewCounts(), { 'c1:web': 2, 'c1:other': 1 });
  await h.client.close(first);
  assert.deepEqual(h.client.sshViewCounts(), { 'c1:web': 1, 'c1:other': 1 });
});

test('an SSH view without a profile id contributes no count and no timing stage', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/');
  assert.deepEqual(h.client.sshViewCounts(), {});
});

test('SSH connect and open round trips become completed stage offsets', async (t) => {
  const h = await loaded(t);
  h.handlers['/api/ssh-remote/connect'] = () => response({ ok: true, host: { id: 'c1', name: 'alpha', phase: 'connected' } });
  h.handlers['/api/ssh-remote/web/open'] = () => response({ ok: true, instanceId: 'i1', profileId: 'web', url: 'http://127.0.0.1:49152/' });
  h.clock.now = 1000;
  const connecting = h.client.sshRequest('/connect', { body: { hostId: 'c1' } });
  h.clock.now = 1300;
  await connecting;
  const opening = h.client.sshRequest('/web/open', { body: { hostId: 'c1', profileId: 'web' } });
  h.clock.now = 1800;
  await opening;
  h.clock.now = 1500;
  h.autoSurfaces();
  await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'web' });
  await flush();
  h.guests[0].ready();
  await flush();
  const entry = h.client.timing.getSnapshot().entries[0];
  const stages = Object.fromEntries(entry.stages.map((stage) => [stage.stage, stage.at]));
  assert.equal(stages.connect, 300, 'connect duration is measured from the request start');
  assert.equal(stages.instance, 800, 'instance includes connect plus the remote web open');
  assert.equal(entry.reused, true);
  assert.doesNotMatch(JSON.stringify(entry), /c1|http|i1/);
});

test('a newer measurement of the same key suppresses a late older finish', async (t) => {
  const h = await loaded(t, { noTiming: true });
  const timing = createWebTiming({ now: () => h.clock.now, limit: 4 });
  h.clock.now = 0;
  const older = timing.begin({ key: 'local-web:alpha', source: 'local', profile: 'alpha' });
  h.clock.now = 10;
  const newer = timing.begin({ key: 'local-web:alpha', source: 'local', profile: 'alpha' });
  h.clock.now = 20;
  assert.equal(newer.finish(), true);
  assert.equal(older.finish(), false, 'the retired measurement cannot publish');
  assert.equal(timing.getSnapshot().entries.length, 1);
  assert.equal(timing.getSnapshot().entries[0].totalMs, 10, 'the surviving measurement keeps its own start time');
});

test('an SSH launcher conversion uses explicit instance and profile metadata', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const launcher = await h.client.openLauncher();
  const converted = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'web', instanceId: 'i1', launcherId: launcher });
  assert.equal(converted, launcher);
  assert.equal(tab(h.client, launcher).kind, 'profile-ui');
  assert.deepEqual(h.client.sshViewCounts(), { 'c1:web': 1 });
  await flush();
  h.guests[0].ready();
  await flush();
  const entry = h.client.timing.getSnapshot().entries[0];
  assert.equal(entry.source, 'ssh');
  assert.equal(entry.profile, 'web');
  assert.doesNotMatch(JSON.stringify(entry), /c1|49152|http/);
});

test('stopping one SSH Host closes only views attached to that instance', async (t) => {
  const h = await loaded(t);
  h.autoSurfaces();
  const first = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49152/', { profileId: 'web', instanceId: 'i1' });
  const second = await h.client.openSshWeb({ id: 'c1', name: 'alpha' }, 'http://127.0.0.1:49153/', { profileId: 'work', instanceId: 'i2' });
  const other = await h.client.openSshWeb({ id: 'c2', name: 'other' }, 'http://127.0.0.1:49154/', { profileId: 'web', instanceId: 'i3' });
  await h.client.closeSshViews('c1', 'i1');
  assert.equal(tab(h.client, first), undefined);
  assert.ok(tab(h.client, second));
  assert.ok(tab(h.client, other));
  assert.deepEqual(h.client.sshViewCounts(), { 'c1:work': 1, 'c2:web': 1 });
});
