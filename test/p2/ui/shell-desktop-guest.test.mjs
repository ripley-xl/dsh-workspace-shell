import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopGuest } from '../../../packages/shell/src/desktop-guest.js';

class MockWebview {
  constructor() {
    this.attributes = {};
    this.style = {};
    this.listeners = new Map();
    this.loadCalls = [];
    this.posted = [];
    this.currentWindow = undefined;
    this.focusCalls = 0;
    this.blurCalls = 0;
    this.removeCalls = 0;
    this.removeListenerCalls = [];
    this.isConnected = false;
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.removeListenerCalls.push(name);
    if (this.throwRemoveListener) throw new Error('remove listener failed');
    this.listeners.get(name)?.delete(listener);
  }

  emit(name, event = {}) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  loadURL(url) {
    this.loadCalls.push(url);
    this.currentURL = url;
    if (this.loadImplementation) return this.loadImplementation(url);
    return Promise.resolve();
  }

  get contentWindow() {
    if (!this.currentWindow) {
      this.currentWindow = {
        postMessage: (message, targetOrigin) => {
          this.posted.push({ data: message, targetOrigin });
          if (this.postMessageImplementation) this.postMessageImplementation(message, targetOrigin);
        },
      };
    }
    return this.currentWindow;
  }

  getURL() {
    return this.currentURL ?? 'https://example.com/guest?q=1';
  }

  focus() {
    this.focusCalls += 1;
  }

  blur() {
    this.blurCalls += 1;
  }

  remove() {
    this.removeCalls += 1;
    if (this.throwRemove) throw new Error('DOM removal failed');
    this.parentNode?.removeChild(this);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

// The framing window only exposes the pieces the guest is allowed to touch.
function framingWindow(origin = 'https://parent.example') {
  const listeners = new Map();
  let uuids = 0;
  const crypto = { randomUUID: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}` };
  const window = {
    crypto,
    location: { origin },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    setTimeout(fn, delay) { return setTimeout(fn, delay); },
    clearTimeout(id) { clearTimeout(id); },
    deliver(event) { for (const listener of [...(listeners.get('message') ?? [])]) listener(event); },
    listenerCount() { return listeners.get('message')?.size ?? 0; },
    get uuids() { return uuids; },
  };
  return window;
}

function harness() {
  const calls = { acquire: [], onOpen: [], release: [] };
  const elements = [];
  const openListeners = new Map();
  const bridge = {
    async acquire(workspace) {
      calls.acquire.push(workspace);
      return { lease: `lease-${calls.acquire.length}`, partition: `partition-${calls.acquire.length}` };
    },
    async release(lease) {
      calls.release.push(lease);
    },
    onOpenRequested(lease, listener) {
      calls.onOpen.push(lease);
      openListeners.set(lease, listener);
      return () => {
        if (bridge.throwUnsubscribe) throw new Error('unsubscribe failed');
        openListeners.delete(lease);
      };
    },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'webview');
      const element = new MockWebview();
      elements.push(element);
      return element;
    },
  };
  const container = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      element.parentNode = this;
      element.isConnected = true;
    },
    removeChild(element) {
      this.children = this.children.filter((child) => child !== element);
      element.parentNode = null;
      element.isConnected = false;
    },
  };
  const window = framingWindow();
  return { bridge, calls, container, document, elements, openListeners, window };
}

function options(mock, overrides = {}) {
  return {
    bridge: mock.bridge,
    container: mock.container,
    document: mock.document,
    window: mock.window,
    url: 'https://example.com/guest?q=1',
    workspaceKey: 'workspace-profile:profile-1',
    ...overrides,
  };
}

// Answer the single pending request the way the companion would.
function replyCwd(mock, element, cwd, overrides = {}) {
  assert.equal(element.contentWindow !== undefined, true);
  const request = element.posted.at(-1);
  assert.ok(request, 'a cwd request must be posted first');
  mock.window.deliver({
    data: {
      type: 'workspace-shell-cwd-response',
      version: 1,
      requestId: request.data.requestId,
      cwd,
      ...overrides.data,
    },
    origin: 'https://example.com',
    source: element.contentWindow,
    ...overrides,
  });
  return request;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('rejects unsafe URLs and invalid workspaces before acquire with safe errors only', async () => {
  const invalidUrls = [
    'javascript:alert(1)',
    'file:///tmp/private',
    'dsh-app://local',
    'https://user:password@example.com/private',
    'not a URL',
  ];
  for (const url of invalidUrls) {
    const mock = harness();
    const errors = [];
    const guest = createDesktopGuest(options(mock, { url, onError: (error) => errors.push(error) }));
    await guest.start();
    assert.deepEqual(mock.calls.acquire, []);
    assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_INVALID_URL' }]);
    assert.deepEqual(Object.keys(errors[0]), ['code']);
    assert.equal(JSON.stringify(errors).includes(url), false);
  }

  for (const workspaceKey of ['', 'x'.repeat(4097)]) {
    const mock = harness();
    const errors = [];
    const guest = createDesktopGuest(options(mock, { workspaceKey, onError: (error) => errors.push(error) }));
    await guest.start();
    assert.deepEqual(mock.calls.acquire, []);
    assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_INVALID_WORKSPACE' }]);
  }
});

test('starts once, acquires the exact workspace, and loads once after dom-ready', async () => {
  const mock = harness();
  let ready = 0;
  const url = 'https://example.com/remote?q=1';
  const guest = createDesktopGuest(options(mock, { url, onReady: () => { ready += 1; } }));
  const starting = guest.start();
  assert.equal(guest.start(), starting);
  await starting;
  await guest.start();
  assert.deepEqual(mock.calls.acquire, ['workspace-profile:profile-1']);
  assert.equal(mock.elements.length, 1);
  const element = mock.elements[0];
  assert.deepEqual(element.attributes, {
    allowpopups: '',
    name: 'lease-1',
    partition: 'partition-1',
    src: 'about:blank#lease-1',
    webpreferences: 'sandbox=yes,contextIsolation=yes,nodeIntegration=no,nodeIntegrationInWorker=no,nodeIntegrationInSubFrames=no',
  });
  assert.equal(element.attributes.preload, undefined);
  assert.equal(element.attributes['data-sidebar-browser-frame'], undefined);
  assert.deepEqual(element.style, {
    border: '0',
    display: 'flex',
    height: '100%',
    minHeight: '0',
    minWidth: '0',
    pointerEvents: 'auto',
    visibility: 'visible',
    width: '100%',
  });
  assert.deepEqual(element.loadCalls, []);
  assert.deepEqual(mock.calls.onOpen, ['lease-1']);

  element.emit('dom-ready');
  element.emit('dom-ready');
  await flush();
  assert.deepEqual(element.loadCalls, [
    `${url}&workspaceShellParentOrigin=${encodeURIComponent('https://parent.example')}`,
  ]);
  assert.equal(ready, 1);
  await guest.dispose();
  assert.deepEqual(mock.calls.release, ['lease-1']);
});

test('the target URL carries the current parent origin, preserving existing parameters', async () => {
  const mock = harness();
  const url = 'http://127.0.0.1:4567/app?token=secret&workspaceShellEmbedded=1#thread';
  const guest = createDesktopGuest(options(mock, { url }));
  await guest.start();
  mock.elements[0].emit('dom-ready');
  await flush();
  const loaded = new URL(mock.elements[0].loadCalls[0]);
  assert.equal(loaded.origin, 'http://127.0.0.1:4567');
  assert.equal(loaded.hash, '#thread');
  assert.equal(loaded.searchParams.get('token'), 'secret');
  assert.equal(loaded.searchParams.get('workspaceShellEmbedded'), '1');
  assert.equal(loaded.searchParams.get('workspaceShellParentOrigin'), 'https://parent.example');
  await guest.dispose();
});

test('an explicit parent origin wins and a missing origin falls back to the guest origin', async () => {
  const explicit = harness();
  const explicitGuest = createDesktopGuest(options(explicit, { parentOrigin: 'https://other.example:8443' }));
  await explicitGuest.start();
  explicit.elements[0].emit('dom-ready');
  await flush();
  assert.equal(new URL(explicit.elements[0].loadCalls[0]).searchParams.get('workspaceShellParentOrigin'), 'https://other.example:8443');
  await explicitGuest.dispose();

  for (const parentOrigin of ['*', 'null', 'javascript:alert(1)', 'https://parent.example/private', 42, '']) {
    const mock = harness();
    mock.window.location = undefined;
    const guest = createDesktopGuest(options(mock, { parentOrigin }));
    await guest.start();
    mock.elements[0].emit('dom-ready');
    await flush();
    assert.equal(new URL(mock.elements[0].loadCalls[0]).searchParams.get('workspaceShellParentOrigin'), 'https://example.com');
    await guest.dispose();
  }
});

test('onReady exceptions are isolated and do not close the guest', async () => {
  const mock = harness();
  const errors = [];
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => { throw new Error('consumer failed'); },
  }));
  await guest.start();
  mock.elements[0].emit('dom-ready');
  await flush();
  assert.deepEqual(errors, []);
  assert.equal(mock.container.children.length, 1);
  assert.deepEqual(mock.calls.release, []);
  await guest.dispose();
});

test('visibility retains the loaded DOM, blurs on hide, and never focuses on show', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  guest.focus();
  assert.equal(element.focusCalls, 0);
  element.emit('dom-ready');
  await flush();
  guest.focus();
  assert.equal(element.focusCalls, 1);

  guest.setVisible(false);
  assert.equal(mock.container.children[0], element);
  assert.equal(element.isConnected, true);
  assert.equal(element.style.display, 'flex');
  assert.equal(element.style.visibility, 'hidden');
  assert.equal(element.style.pointerEvents, 'none');
  assert.equal(element.blurCalls, 1);
  assert.deepEqual(element.loadCalls, ['https://example.com/guest?q=1&workspaceShellParentOrigin=https%3A%2F%2Fparent.example']);
  guest.focus();
  assert.equal(element.focusCalls, 1);

  guest.setVisible(true);
  assert.equal(element.style.visibility, 'visible');
  assert.equal(element.style.pointerEvents, 'auto');
  assert.equal(element.focusCalls, 1);
  element.isConnected = false;
  guest.focus();
  assert.equal(element.focusCalls, 1);
  element.isConnected = true;
  guest.focus();
  assert.equal(element.focusCalls, 2);
  await guest.dispose();
  guest.focus();
  assert.equal(element.focusCalls, 2);
});

test('working directory asks the ready same-origin companion over postMessage instead of evaluating script', async () => {
  const mock = harness();
  const errors = [];
  const guest = createDesktopGuest(options(mock, { onError: (error) => errors.push(error) }));
  await guest.start();
  const element = mock.elements[0];
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.deepEqual(element.posted, []);
  element.emit('dom-ready');
  await flush();
  assert.equal(element.attributes.preload, undefined);
  for (const invalid of [null, '', '   ', { cwd: '/object' }, 42]) {
    const reading = guest.getWorkingDirectory();
    await flush();
    replyCwd(mock, element, invalid);
    assert.equal(await reading, null);
  }
  const before = element.posted.length;
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(element.posted.length, before + 1);
  const request = replyCwd(mock, element, '/effective-session-cwd');
  assert.deepEqual(Object.keys(request.data).sort(), ['requestId', 'type', 'version']);
  assert.equal(request.data.type, 'workspace-shell-cwd-request');
  assert.equal(request.data.version, 1);
  assert.match(request.data.requestId, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(request.targetOrigin, 'https://example.com');
  assert.equal(await reading, '/effective-session-cwd');
  assert.equal(element.scriptCalls, undefined, 'the guest is never scripted');
  assert.deepEqual(errors, []);
  await guest.dispose();
  assert.equal(await guest.getWorkingDirectory(), null);
});

test('a request is posted only while the guest is ready, connected, and same-origin', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  assert.equal(await guest.getWorkingDirectory(), null);
  element.emit('dom-ready');
  await flush();
  const reads = () => element.posted.length;
  assert.equal(reads(), 0);
  element.currentURL = 'https://other.example/private';
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.equal(reads(), 0, 'origin validation precedes the request');
  element.currentURL = 'https://example.com/guest?q=1';
  element.isConnected = false;
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.equal(reads(), 0);
  element.isConnected = true;
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(reads(), 1);
  element.currentURL = 'https://other.example/private';
  replyCwd(mock, element, '/cwd-from-a-stale-navigation');
  assert.equal(await reading, null, 'a guest that left the origin cannot answer');
  await guest.dispose();
});

test('responses must match the pending request id, the guest window, the origin, and ready state', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  element.emit('dom-ready');
  await flush();
  const attempts = [
    { data: { type: 'workspace-shell-cwd-request', version: 1, requestId: 'x'.repeat(20), cwd: '/echo' } },
    { data: { type: 'workspace-shell-cwd-response', version: 2, requestId: 'stale-request-id-0000', cwd: '/version' } },
    { data: null },
    { data: 'text' },
    { data: ['array'] },
    { source: {} },
    { origin: 'https://other.example' },
    { origin: undefined },
    { data: { cwd: '/missing-type' } },
  ];
  const reading = guest.getWorkingDirectory();
  await flush();
  const pending = element.posted;
  assert.equal(pending.length, 1);
  for (const attempt of attempts) {
    replyCwd(mock, element, '/spoofed', attempt);
    await flush();
  }
  assert.equal(await Promise.race([reading, new Promise((resolve) => setTimeout(() => resolve('pending'), 50))]), 'pending');
  replyCwd(mock, element, '/accepted');
  assert.equal(await reading, '/accepted');
  assert.equal(element.posted.length, 1);
  await guest.dispose();
});

test('the message listener is installed lazily, removed on dispose, and stops publishing', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  assert.equal(mock.window.listenerCount(), 0);
  await guest.start();
  const element = mock.elements[0];
  element.emit('dom-ready');
  await flush();
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(mock.window.listenerCount(), 1);
  const disposal = guest.dispose();
  replyCwd(mock, element, '/late-cwd');
  assert.equal(await reading, null);
  await disposal;
  assert.equal(mock.window.listenerCount(), 0);
  assert.deepEqual(mock.calls.release, ['lease-1']);
});

test('a response arriving after navigation is dropped and the next read uses a fresh id', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  element.emit('dom-ready');
  await flush();
  const reading = guest.getWorkingDirectory();
  await flush();
  const first = element.posted.at(-1).data.requestId;
  element.emit('did-navigate', { url: 'https://example.com/next' });
  element.currentURL = 'https://example.com/next';
  replyCwd(mock, element, '/stale-cwd');
  assert.equal(await reading, null);
  const next = guest.getWorkingDirectory();
  await flush();
  const second = element.posted.at(-1).data.requestId;
  assert.notEqual(second, first);
  replyCwd(mock, element, '/fresh-cwd');
  assert.equal(await next, '/fresh-cwd');
  await guest.dispose();
});

test('the cwd channel times out after one second and clears its timer', async () => {
  const mock = harness();
  const timers = new Map();
  let nextTimer = 0;
  const window = { ...mock.window,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const guest = createDesktopGuest(options(mock, { window }));
  await guest.start();
  const element = mock.elements[0];
  element.emit('dom-ready');
  await flush();
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(timers.size, 1);
  for (const fire of timers.values()) fire();
  assert.equal(await reading, null);
  assert.equal(timers.size, 0);
  replyCwd(mock, element, '/after-timeout');
  await flush();
  await guest.dispose();
});

test('resize is a no-op and does not require a bridge resize API', async () => {
  const mock = harness();
  const guest = createDesktopGuest(options(mock));
  guest.resize();
  await guest.start();
  const element = mock.elements[0];
  const style = { ...element.style };
  assert.equal('resize' in mock.bridge, false);
  assert.equal(guest.resize(), undefined);
  assert.deepEqual(element.style, style);
  assert.notEqual(element.style.width, '0');
  assert.notEqual(element.style.height, '0');
  await guest.dispose();
});

test('abort before start and dispose before start never acquire', async () => {
  const controller = new AbortController();
  const mock = harness();
  controller.abort();
  const aborted = createDesktopGuest(options(mock, { signal: controller.signal }));
  await aborted.start();
  assert.deepEqual(mock.calls.acquire, []);

  const disposed = createDesktopGuest(options(mock));
  await disposed.dispose();
  await disposed.start();
  assert.deepEqual(mock.calls.acquire, []);
});

test('late acquire after abort releases the raw lease without creating a guest', async () => {
  const mock = harness();
  const controller = new AbortController();
  const acquired = deferred();
  mock.bridge.acquire = async (workspace) => {
    mock.calls.acquire.push(workspace);
    return acquired.promise;
  };
  const guest = createDesktopGuest(options(mock, { signal: controller.signal }));
  const starting = guest.start();
  await flush();
  controller.abort();
  const disposing = guest.dispose();
  acquired.resolve({ lease: 'late-lease', partition: 'late-partition' });
  await Promise.all([starting, disposing]);
  assert.deepEqual(mock.calls.release, ['late-lease']);
  assert.equal(mock.elements.length, 0);
  await guest.start();
  assert.deepEqual(mock.calls.acquire, ['workspace-profile:profile-1']);
});

test('abort before dom-ready cleans up and cannot start a later load', async () => {
  const mock = harness();
  const controller = new AbortController();
  const guest = createDesktopGuest(options(mock, { signal: controller.signal }));
  await guest.start();
  const element = mock.elements[0];
  controller.abort();
  await guest.dispose();
  element.emit('dom-ready');
  await flush();
  assert.deepEqual(element.loadCalls, []);
  assert.deepEqual(mock.calls.release, ['lease-1']);
});

test('abort during load prevents late ready and releases once', async () => {
  const mock = harness();
  const controller = new AbortController();
  const loading = deferred();
  let ready = 0;
  const guest = createDesktopGuest(options(mock, {
    signal: controller.signal,
    onReady: () => { ready += 1; },
  }));
  await guest.start();
  mock.elements[0].loadImplementation = () => loading.promise;
  mock.elements[0].emit('dom-ready');
  controller.abort();
  await guest.dispose();
  loading.resolve();
  await flush();
  assert.equal(ready, 0);
  assert.deepEqual(mock.calls.release, ['lease-1']);
});

test('ERR_ABORTED is neither failure nor ready even if load later resolves', async () => {
  const mock = harness();
  const loading = deferred();
  const errors = [];
  let ready = 0;
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => { ready += 1; },
  }));
  await guest.start();
  const element = mock.elements[0];
  element.loadImplementation = () => loading.promise;
  element.emit('dom-ready');
  element.emit('did-fail-load', { isMainFrame: false, errorCode: -105 });
  element.emit('did-fail-load', {
    isMainFrame: true,
    errorCode: -3,
    validatedURL: 'https://example.com/guest?q=1',
  });
  loading.resolve();
  await flush();
  assert.equal(ready, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.calls.release, []);
  await guest.dispose();
});

test('aborting the initial blank navigation does not poison the target load', async () => {
  const mock = harness();
  const loading = deferred();
  const errors = [];
  let ready = 0;
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => { ready += 1; },
  }));
  await guest.start();
  const element = mock.elements[0];
  element.loadImplementation = () => loading.promise;
  element.emit('dom-ready');
  element.emit('did-fail-load', {
    errorCode: -3,
    isMainFrame: true,
    validatedURL: 'about:blank#lease-1',
  });
  element.emit('did-fail-load', {
    errorCode: -3,
    isMainFrame: true,
    validatedURL: 'https://other.example/cancelled',
  });
  loading.resolve();
  await flush();
  assert.equal(ready, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(element.loadCalls, ['https://example.com/guest?q=1&workspaceShellParentOrigin=https%3A%2F%2Fparent.example']);
  await guest.dispose();
});

test('main-frame failure closes before a late load resolution and never becomes ready', async () => {
  const mock = harness();
  const loading = deferred();
  const errors = [];
  let ready = 0;
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => { ready += 1; },
  }));
  await guest.start();
  const element = mock.elements[0];
  element.loadImplementation = () => loading.promise;
  element.emit('dom-ready');
  element.emit('did-fail-load', {
    errorCode: -105,
    errorURL: 'https://example.com/guest?q=secret',
    isMainFrame: true,
  });
  await guest.dispose();
  loading.resolve();
  await flush();
  assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_LOAD_FAILED' }]);
  assert.equal(ready, 0);
  assert.deepEqual(mock.calls.release, ['lease-1']);
  assert.equal(JSON.stringify(errors).includes('secret'), false);
});

test('loadURL rejection and synchronous throw use the fixed load error code', async () => {
  for (const synchronous of [false, true]) {
    const mock = harness();
    const errors = [];
    const guest = createDesktopGuest(options(mock, { onError: (error) => errors.push(error) }));
    await guest.start();
    const element = mock.elements[0];
    element.loadImplementation = () => {
      if (synchronous) throw new Error('private load failure');
      return Promise.reject(new Error('private load failure'));
    };
    element.emit('dom-ready');
    await flush();
    await guest.dispose();
    assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_LOAD_FAILED' }]);
    assert.deepEqual(mock.calls.release, ['lease-1']);
  }
});

test('loadURL rejection with ERR_ABORTED stays unready without a failure callback', async () => {
  const mock = harness();
  const errors = [];
  let ready = 0;
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => { ready += 1; },
  }));
  await guest.start();
  mock.elements[0].loadImplementation = () => Promise.reject(Object.assign(new Error('aborted'), {
    errorCode: -3,
  }));
  mock.elements[0].emit('dom-ready');
  await flush();
  assert.equal(ready, 0);
  assert.deepEqual(errors, []);
  await guest.dispose();
  assert.deepEqual(mock.calls.release, ['lease-1']);
});

test('malformed partition still releases the known raw lease, with no legacy aliases', async () => {
  const malformed = harness();
  malformed.bridge.acquire = async () => ({ lease: 'known-token', partition: null });
  const errors = [];
  const guest = createDesktopGuest(options(malformed, { onError: (error) => errors.push(error) }));
  await guest.start();
  assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_LEASE_INVALID' }]);
  assert.deepEqual(malformed.calls.release, ['known-token']);
  assert.equal(malformed.elements.length, 0);

  const legacy = harness();
  legacy.bridge.acquire = async () => ({ leaseId: 'legacy-token', partitionId: 'legacy-partition' });
  const legacyGuest = createDesktopGuest(options(legacy));
  await legacyGuest.start();
  assert.deepEqual(legacy.calls.release, []);
});

test('acquire rejection is safe and does not guess a release token', async () => {
  const mock = harness();
  mock.bridge.acquire = async () => {
    throw new Error('failed for https://user:secret@example.com');
  };
  const errors = [];
  const guest = createDesktopGuest(options(mock, { onError: (error) => errors.push(error) }));
  await guest.start();
  assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_ACQUIRE_FAILED' }]);
  assert.equal(JSON.stringify(errors).includes('secret'), false);
  assert.deepEqual(mock.calls.release, []);
});

test('openExternal runs only for explicit valid requests and isolates callback errors', async () => {
  const mock = harness();
  const opened = [];
  const errors = [];
  let throwOnOpen = false;
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    openExternal: (url) => {
      if (throwOnOpen) throw new Error('consumer open failed');
      opened.push(url);
    },
  }));
  await guest.start();
  assert.deepEqual(opened, []);
  const listener = mock.openListeners.get('lease-1');
  listener('file:///tmp/private');
  listener('https://user:password@example.com/private');
  assert.deepEqual(opened, []);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.code === 'DESKTOP_GUEST_EXTERNAL_URL_REJECTED'));
  assert.equal(JSON.stringify(errors).includes('password'), false);
  listener('https://example.com/docs');
  assert.deepEqual(opened, ['https://example.com/docs']);
  throwOnOpen = true;
  listener('https://example.com/throws');
  assert.equal(errors.length, 2);
  assert.equal(mock.container.children.length, 1);
  await guest.dispose();
  assert.equal(mock.openListeners.size, 0);
});

test('throwing onError, unsubscribe, listener removal and DOM removal still release once', async () => {
  const mock = harness();
  let errorCalls = 0;
  let guest;
  mock.bridge.throwUnsubscribe = true;
  mock.bridge.onOpenRequested = (lease, listener) => {
    mock.calls.onOpen.push(lease);
    mock.openListeners.set(lease, listener);
    return () => {
      mock.openListeners.delete(lease);
      guest.dispose();
      throw new Error('unsubscribe failed');
    };
  };
  guest = createDesktopGuest(options(mock, {
    onError: () => {
      errorCalls += 1;
      throw new Error('consumer error callback failed');
    },
  }));
  await guest.start();
  const element = mock.elements[0];
  element.throwRemoveListener = true;
  element.throwRemove = true;
  element.emit('render-process-gone', { reason: 'crashed' });
  await guest.dispose();
  assert.equal(errorCalls, 1);
  assert.equal(element.removeCalls, 1);
  assert.deepEqual(element.removeListenerCalls, ['dom-ready', 'did-fail-load', 'render-process-gone', 'did-navigate', 'did-navigate-in-page']);
  assert.deepEqual(mock.calls.release, ['lease-1']);
  assert.equal(mock.openListeners.size, 0);
});

test('onError can reenter start and return a rejected Promise without recursion or unhandled rejection', async () => {
  const mock = harness();
  let guest;
  let reentrant;
  let errors = 0;
  guest = createDesktopGuest(options(mock, {
    url: 'javascript:alert(1)',
    onError: () => {
      errors += 1;
      reentrant = guest.start();
      return Promise.reject(new Error('async consumer failure'));
    },
  }));
  const starting = guest.start();
  await starting;
  await flush();
  assert.equal(errors, 1);
  assert.equal(reentrant, starting);
  assert.deepEqual(mock.calls.acquire, []);
});

test('async onReady and openExternal rejections are contained', async () => {
  const mock = harness();
  const errors = [];
  const guest = createDesktopGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: async () => { throw new Error('async ready failure'); },
    openExternal: async () => { throw new Error('async open failure'); },
  }));
  await guest.start();
  mock.elements[0].emit('dom-ready');
  await flush();
  mock.openListeners.get('lease-1')('https://example.com/docs');
  await flush();
  assert.deepEqual(errors, []);
  assert.equal(mock.container.children.length, 1);
  await guest.dispose();
});

test('release rejection is contained, reported safely, and never retried', async () => {
  const mock = harness();
  mock.bridge.release = async (lease) => {
    mock.calls.release.push(lease);
    throw new Error('release failed with a private token');
  };
  const errors = [];
  const guest = createDesktopGuest(options(mock, { onError: (error) => errors.push(error) }));
  await guest.start();
  const first = guest.dispose();
  const second = guest.dispose();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await guest.dispose();
  await guest.start();
  assert.deepEqual(mock.calls.acquire, ['workspace-profile:profile-1']);
  assert.deepEqual(mock.calls.release, ['lease-1']);
  assert.deepEqual(errors, [{ code: 'DESKTOP_GUEST_RELEASE_FAILED' }]);
});
