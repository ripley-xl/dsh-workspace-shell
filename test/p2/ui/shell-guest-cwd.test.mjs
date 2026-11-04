import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const GLOBAL_KEY = '__workspaceShellGuestCwd';
const packageRoot = new URL('../../../packages/shell/guest-cwd/', import.meta.url);
const clientSource = await readFile(new URL('client.js', packageRoot), 'utf8');
const emptySnapshot = () => ({ phase: 'ready', ids: [], byId: {} });
const plain = (value) => JSON.parse(JSON.stringify(value));
const mainRow = (projectionValues, count = 1) => ({
  retainedBy: { mainView: count },
  ...(projectionValues === undefined ? {} : { projectionValues }),
});

function loadClient(window = {}) {
  let registration;
  window.__ModuleLoader__ = {
    load(value) {
      assert.equal(registration, undefined);
      registration = value;
    },
  };
  vm.runInNewContext(clientSource, { window, URL, URLSearchParams }, { filename: 'guest-cwd-client.js' });
  assert.equal(registration.id, 'dsh-workspace-shell-guest-cwd');
  assert.equal(typeof registration.factory, 'function');
  const plugin = registration.factory();
  assert.deepEqual([...plugin.inject], ['sessions']);
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject']);
  return { plugin, window };
}

function harness(options = {}) {
  const { plugin, window } = loadClient(options.window);
  const messageListeners = new Set();
  let addingListeners = options.failAddListener !== true;
  const parent = options.parent ?? {};
  window.parent = parent === null ? window : parent;
  if (parent !== window && typeof parent.postMessage !== 'function') {
    parent.postMessage = (message, origin) => {
      (options.sent ??= []).push({ message, origin });
    };
  }
  window.location = options.location ?? { search: '' };
  window.addEventListener = (name, listener) => {
    if (name !== 'message') return;
    if (!addingListeners) throw new Error('listener registration failed');
    messageListeners.add(listener);
  };
  window.removeEventListener = (name, listener) => {
    if (name !== 'message') return;
    messageListeners.delete(listener);
  };
  window.postMessage = (message, origin) => {
    (options.sent ??= []).push({ message, origin });
  };
  let snapshot = options.snapshot ?? emptySnapshot();
  let reads = 0;
  const disposers = [];
  const labels = [];
  const ctx = {
    sessions: {
      list: {
        getSnapshot(...args) {
          assert.deepEqual(args, []);
          reads++;
          if (options.snapshotError) throw options.snapshotError;
          return snapshot;
        },
      },
    },
    effect(setup, label) {
      labels.push(label);
      const dispose = setup();
      assert.equal(typeof dispose, 'function');
      disposers.push(dispose);
    },
  };
  options.prepareWindow?.(window);
  return {
    ctx,
    labels,
    plugin,
    reads: () => reads,
    setSnapshot(value) { snapshot = value; },
    apply: () => plugin.apply(ctx),
    dispose() { for (const dispose of [...disposers].reverse()) dispose(); },
    get disposerCount() { return disposers.length; },
    get globalValue() { return window[GLOBAL_KEY]; },
    get listenerCount() { return messageListeners.size; },
    get sent() { return options.sent ?? []; },
    parent,
    deliver(event) { for (const listener of [...messageListeners]) listener(event); },
    closeListeners() { addingListeners = false; },
    get ownGlobal() { return Object.getOwnPropertyDescriptor(window, GLOBAL_KEY); },
    window,
  };
}

test('package, Host no-op, and patch declare only the narrow companion composition', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.1-rc.5');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-api-session-controller']);
  assert.deepEqual(manifest.files.sort(), ['client.js', 'cordis.patch.yml', 'index.js']);
  const patch = await readFile(new URL('cordis.patch.yml', packageRoot), 'utf8');
  assert.match(patch, /id:\s*workspace-shell-guest-cwd/);
  assert.match(patch, /name:\s*\.\/index\.js/);
  const host = await import(new URL('index.js', packageRoot));
  assert.deepEqual(Object.keys(host), ['apply']);
  assert.equal(host.apply(), undefined);
});

test('one mainView row exposes only its effective string cwd through a zero-argument global', () => {
  const h = harness({ snapshot: {
    ...emptySnapshot(),
    byId: {
      background: { retainedBy: {}, projectionValues: { workingDirectory: '/other' } },
      current: { ...mainRow({ workingDirectory: '/effective' }), id: 'private-id', title: 'private-title', cwd: '/original' },
    },
  } });
  h.apply();
  assert.equal(typeof h.globalValue, 'function');
  assert.equal(h.globalValue.length, 0);
  assert.equal(h.globalValue(), '/effective');
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.labels, ['workspace shell Guest cwd scalar']);
  assert.deepEqual({ ...h.ownGlobal, value: undefined }, {
    value: undefined, writable: false, enumerable: false, configurable: true,
  });
  h.dispose();
});

test('each read uses one fresh public snapshot without subscriptions or lookup arguments', () => {
  const h = harness({ snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/first' }) } } });
  h.apply();
  assert.equal(h.globalValue(), '/first');
  h.setSnapshot({ ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/second' }) } });
  assert.equal(h.globalValue(), '/second');
  assert.equal(h.reads(), 2);
  assert.equal(h.ctx.sessions.list.subscribe, undefined);
  h.dispose();
});

test('zero, inactive, or multiple mainView-retained rows return null', () => {
  const h = harness();
  h.apply();
  assert.equal(h.globalValue(), null);
  h.setSnapshot({ ...emptySnapshot(), byId: {
    zero: mainRow({ workingDirectory: '/zero' }, 0),
    missing: { retainedBy: {}, cwd: '/not-effective' },
  } });
  assert.equal(h.globalValue(), null);
  h.setSnapshot({ ...emptySnapshot(), byId: {
    first: mainRow({ workingDirectory: '/first' }),
    second: mainRow({ workingDirectory: '/second' }, 2),
  } });
  assert.equal(h.globalValue(), null);
  h.setSnapshot({ ...emptySnapshot(), byId: {
    current: mainRow({ workingDirectory: '/only' }),
    inactive: mainRow({ workingDirectory: '/inactive' }, -1),
  } });
  assert.equal(h.globalValue(), '/only');
  h.dispose();
});

test('explicit null, absent projection, and non-string projection values all return null', () => {
  const h = harness({ snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: null }) } } });
  h.apply();
  assert.equal(h.globalValue(), null);
  for (const row of [
    mainRow(undefined),
    mainRow({}),
    mainRow({ workingDirectory: undefined }),
    mainRow({ workingDirectory: 42 }),
    mainRow({ workingDirectory: { path: '/object' } }),
  ]) {
    h.setSnapshot({ ...emptySnapshot(), byId: { current: row } });
    assert.equal(h.globalValue(), null);
  }
  h.dispose();
});

test('raw cwd, Session identity, title, and body getters are never read as fallbacks', () => {
  const accesses = [];
  const row = mainRow(undefined);
  for (const key of ['id', 'title', 'cwd', 'body']) {
    Object.defineProperty(row, key, {
      get() { accesses.push(key); throw new Error(`forbidden ${key}`); },
    });
  }
  const h = harness({ snapshot: { ...emptySnapshot(), byId: { current: row } } });
  h.apply();
  assert.equal(h.globalValue(), null);
  assert.deepEqual(accesses, []);
  h.dispose();
});

test('snapshot exceptions and malformed retention counts fail closed', () => {
  const throwing = harness({ snapshotError: new Error('private snapshot failure') });
  throwing.apply();
  assert.equal(throwing.globalValue(), null);
  throwing.dispose();

  const h = harness();
  h.apply();
  for (const count of ['1', NaN, Infinity, null, true]) {
    h.setSnapshot({ ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/invalid' }, count) } });
    assert.equal(h.globalValue(), null);
  }
  h.dispose();
});

test('unload deletes only the installed function and cleanup is idempotent', () => {
  const h = harness({ snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/work' }) } } });
  h.apply();
  const installed = h.globalValue;
  assert.equal(h.disposerCount, 1);
  h.dispose();
  assert.equal(Object.hasOwn(h.window, GLOBAL_KEY), false);
  Object.defineProperty(h.window, GLOBAL_KEY, { value: installed, configurable: true });
  h.dispose();
  assert.equal(h.ownGlobal.value, installed, 'a completed cleanup must not delete a later reinstallation');
});

test('a foreign replacement survives the original owner cleanup', () => {
  const h = harness();
  const external = () => '/foreign';
  h.apply();
  Object.defineProperty(h.window, GLOBAL_KEY, { value: external, configurable: true, writable: false });
  h.dispose();
  assert.equal(h.globalValue, external);
});

test('occupied, inherited, and duplicate global names are never overwritten', () => {
  const external = () => '/external';
  const occupied = harness({ prepareWindow(window) {
    Object.defineProperty(window, GLOBAL_KEY, { value: external, configurable: false });
  } });
  occupied.apply();
  assert.equal(occupied.globalValue, external);
  assert.equal(occupied.disposerCount, 0);
  assert.equal(occupied.reads(), 0);

  const inherited = harness({ window: Object.create({ [GLOBAL_KEY]: external }) });
  inherited.apply();
  assert.equal(inherited.globalValue, external);
  assert.equal(Object.hasOwn(inherited.window, GLOBAL_KEY), false);
  assert.equal(inherited.disposerCount, 0);

  const duplicate = harness();
  duplicate.apply();
  const installed = duplicate.globalValue;
  duplicate.apply();
  assert.equal(duplicate.globalValue, installed);
  assert.equal(duplicate.disposerCount, 1);
  duplicate.dispose();
});

test('a non-extensible window fails safely without installing or registering cleanup', () => {
  const h = harness({ prepareWindow: Object.preventExtensions });
  assert.doesNotThrow(h.apply);
  assert.equal(Object.hasOwn(h.window, GLOBAL_KEY), false);
  assert.equal(h.disposerCount, 0);
  assert.equal(h.reads(), 0);
});

test('client source contains no retain, subscription, raw-cwd fallback, or snapshot query API', () => {
  assert.doesNotMatch(clientSource, /\.retain\s*\(|\.subscribe\s*\(|\.cwd\b/);
  assert.doesNotMatch(clientSource, /getSnapshot\(\s*[^)\s]/);
});

function requestPayload(overrides = {}) {
  return {
    type: 'workspace-shell-cwd-request',
    version: 1,
    requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ...overrides,
  };
}

test('an embedded guest answers only the declaring parent origin over postMessage', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/effective' }) } },
  });
  h.apply();
  assert.equal(h.listenerCount, 1);
  h.deliver({ data: requestPayload(), origin: 'https://parent.example', source: parent });
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), {
    message: {
      type: 'workspace-shell-cwd-response',
      version: 1,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cwd: '/effective',
    },
    origin: 'https://parent.example',
  });
  h.dispose();
  assert.equal(h.listenerCount, 0);
});

test('foreign sources and origins never get an answer when an origin is declared', () => {
  const cases = [
    { mutate: (event, parent) => ({ ...event, source: {} }), location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' } },
    { mutate: (event) => ({ ...event, origin: 'https://evil.example' }), location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' } },
    { mutate: (event) => ({ ...event, origin: 'https://parent.example:8443' }), location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' } },
  ];
  for (const suite of cases) {
    const parent = { name: 'parent-window' };
    const sent = [];
    const h = harness({ parent, sent, location: suite.location });
    h.apply();
    const event = { data: requestPayload(), origin: 'https://parent.example', source: parent };
    h.deliver(suite.mutate(event, parent));
    assert.equal(sent.length, 0, JSON.stringify(suite.location));
    h.dispose();
  }
});

test('after an authentication redirect, the actual parent origin is bound once', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({ parent, sent, location: { search: '' } });
  h.apply();
  h.deliver({ data: requestPayload(), origin: 'https://parent.example', source: parent });
  h.deliver({ data: requestPayload({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef' }), origin: 'https://evil.example', source: parent });
  h.deliver({ data: requestPayload({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeefff0' }), origin: 'https://parent.example', source: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, 'https://parent.example');
  h.dispose();
});

test('a top-level document installs the global but never installs the message listener', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/top' }) } },
  });
  h.window.parent = h.window;
  h.apply();
  assert.equal(h.listenerCount, 0);
  assert.equal(h.globalValue(), '/top');
  h.dispose();
});

test('malformed requests are ignored and never produce a response', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/effective' }) } },
  });
  h.apply();
  const base = { origin: 'https://parent.example', source: parent };
  for (const data of [
    null,
    'text',
    ['array'],
    {},
    requestPayload({ type: 'workspace-shell-cwd-response' }),
    requestPayload({ version: 2 }),
    requestPayload({ version: '1' }),
    requestPayload({ requestId: '' }),
    requestPayload({ requestId: 'short' }),
    requestPayload({ requestId: 'x'.repeat(129) }),
    requestPayload({ requestId: 42 }),
    requestPayload({ requestId: '../etc/passwd' }),
  ]) {
    h.deliver({ ...base, data });
  }
  assert.equal(sent.length, 0);
  h.dispose();
});

test('responses contain only string or null cwd and never the raw URL or Session identity', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
  });
  h.apply();
  const row = mainRow(undefined);
  for (const key of ['id', 'title', 'cwd', 'body', 'projectionValues']) {
    Object.defineProperty(row, key, { get() { throw new Error(`forbidden ${key}`); } });
  }
  h.setSnapshot({ ...emptySnapshot(), byId: { current: row } });
  h.deliver({ data: requestPayload(), origin: 'https://parent.example', source: parent });
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), {
    message: {
      type: 'workspace-shell-cwd-response',
      version: 1,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cwd: null,
    },
    origin: 'https://parent.example',
  });
  assert.equal(JSON.stringify(sent).includes('token'), false);
  h.dispose();
});

test('a listener registration failure still keeps the scalar global and cleans up', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    failAddListener: true,
    snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/effective' }) } },
  });
  assert.doesNotThrow(h.apply);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.globalValue(), '/effective');
  assert.equal(h.disposerCount, 1);
  h.dispose();
  assert.equal(Object.hasOwn(h.window, GLOBAL_KEY), false);
});

test('a read failure during a request still answers null and leaves the listener installed', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    snapshotError: new Error('private snapshot failure'),
  });
  h.apply();
  h.deliver({ data: requestPayload(), origin: 'https://parent.example', source: parent });
  assert.equal(plain(h.sent[0]).message.cwd, null);
  assert.equal(h.listenerCount, 1);
  h.dispose();
  assert.equal(h.listenerCount, 0);
});

test('unload removes the listener before the global and is idempotent', () => {
  const parent = { name: 'parent-window' };
  const sent = [];
  const h = harness({
    parent,
    sent,
    location: { search: '?workspaceShellParentOrigin=https%3A%2F%2Fparent.example' },
    snapshot: { ...emptySnapshot(), byId: { current: mainRow({ workingDirectory: '/effective' }) } },
  });
  h.apply();
  assert.equal(h.listenerCount, 1);
  h.dispose();
  assert.equal(h.listenerCount, 0);
  assert.equal(Object.hasOwn(h.window, GLOBAL_KEY), false);
  h.dispose();
  assert.equal(h.listenerCount, 0);
  assert.doesNotThrow(() => h.deliver({ data: requestPayload(), origin: 'https://parent.example', source: parent }));
  assert.equal(sent.length, 0);
});

test('client source keeps no subscription, retain, raw-cwd fallback, or URL reporting', () => {
  assert.doesNotMatch(clientSource, /\.retain\s*\(|\.subscribe\s*\(|\.cwd\b/);
  assert.doesNotMatch(clientSource, /getSnapshot\(\s*[^)\s]/);
  assert.doesNotMatch(clientSource, /localStorage|sessionStorage|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(clientSource, /postMessage\([^)]*\burl\b/);
});
