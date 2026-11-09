import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserGuest } from '../../../packages/shell/src/browser-guest.js';

const PARENT_ORIGIN = 'http://127.0.0.1:64016';
const GUEST_URL = 'http://127.0.0.1:4567/app?thread=1';

class MockIframe {
  constructor() {
    this.attributes = {};
    this.style = {};
    this.listeners = new Map();
    this.src = '';
    this.currentWindow = undefined;
    this.focusCalls = 0;
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
    this.listeners.get(name)?.delete(listener);
  }

  emit(name, event = {}) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  get contentWindow() {
    if (!this.currentWindow) {
      this.currentWindow = {
        postMessage: (message, targetOrigin) => {
          this.posts ??= [];
          this.posts.push({ message, targetOrigin });
          this.postImplementation?.(message, targetOrigin);
        },
      };
    }
    return this.currentWindow;
  }

  focus() {
    this.focusCalls += 1;
  }

  remove() {
    this.removeCalls += 1;
    this.parentNode?.removeChild(this);
  }
}

function framingWindow() {
  const listeners = new Map();
  let uuids = 0;
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    location: { origin: PARENT_ORIGIN },
    crypto: { randomUUID: () => `11111111-2222-4333-8444-${String(++uuids).padStart(12, '0')}` },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    deliver(event) { for (const listener of [...(listeners.get('message') ?? [])]) listener(event); },
    listenerCount(name = 'message') { return listeners.get(name)?.size ?? 0; },
    fireTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    get timerCount() { return timers.size; },
    get uuids() { return uuids; },
  };
  return window;
}

function harness() {
  const elements = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const element = new MockIframe();
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
  return { container, document, elements, window: framingWindow() };
}

function options(mock, overrides = {}) {
  return {
    container: mock.container,
    document: mock.document,
    window: mock.window,
    url: GUEST_URL,
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadedFrameAttributes(element) {
  return {
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals',
    allow: 'clipboard-write; clipboard-read',
    referrerpolicy: 'no-referrer',
  };
}

test('only loopback http URLs with an explicit port are accepted before any frame is created', async () => {
  const rejected = [
    'https://127.0.0.1:4567/app',
    'http://example.com:4567/app',
    'http://192.168.1.5:4567/app',
    'http://127.0.0.1/app',
    'dsh-app://app/local',
    'javascript:alert(1)',
    'file:///tmp/private',
    'not a url',
  ];
  for (const url of rejected) {
    const mock = harness();
    const errors = [];
    const guest = createBrowserGuest(options(mock, { url, onError: (error) => errors.push(error) }));
    await guest.start();
    assert.equal(mock.elements.length, 0, url);
    assert.deepEqual(plain(errors), [{ code: 'BROWSER_GUEST_INVALID_URL' }], url);
    assert.equal(JSON.stringify(errors).includes(url), false);
    await guest.dispose();
  }

  // Loopback variants keep the auth URL query; it is never echoed into an error.
  for (const url of [
    'http://127.0.0.1:4567/app?token=1#frag',
    'http://localhost:4567/app',
    'http://[::1]:4567/app',
  ]) {
    const mock = harness();
    const guest = createBrowserGuest(options(mock, { url }));
    await guest.start();
    assert.equal(mock.elements.length, 1, url);
    assert.equal(new URL(mock.elements[0].src).searchParams.get('token'), url.includes('token') ? '1' : null);
    await guest.dispose();
  }
});

test('credentials in a loopback URL are rejected without leaking them', async () => {
  const mock = harness();
  const errors = [];
  const guest = createBrowserGuest(options(mock, {
    url: 'http://user:password@127.0.0.1:4567/app',
    onError: (error) => errors.push(error),
  }));
  await guest.start();
  assert.equal(mock.elements.length, 0);
  assert.deepEqual(plain(errors), [{ code: 'BROWSER_GUEST_INVALID_URL' }]);
  assert.equal(JSON.stringify(errors).includes('password'), false);
});

test('the frame uses the minimal sandbox, the parent origin parameter, and no Native surface', async () => {
  const mock = harness();
  let ready = 0;
  const url = 'http://127.0.0.1:4567/app?workspaceShellEmbedded=1&thread=abc';
  const guest = createBrowserGuest(options(mock, { url, onReady: () => { ready += 1; } }));
  await guest.start();
  assert.equal(mock.elements.length, 1);
  const element = mock.elements[0];
  assert.deepEqual(element.attributes, loadedFrameAttributes());
  const loaded = new URL(element.src);
  assert.equal(loaded.origin, 'http://127.0.0.1:4567');
  assert.equal(loaded.searchParams.get('thread'), 'abc');
  assert.equal(loaded.searchParams.get('workspaceShellEmbedded'), '1');
  assert.equal(loaded.searchParams.get('workspaceShellParentOrigin'), PARENT_ORIGIN);
  assert.equal(element.attributes.allowpopups, undefined);
  assert.equal(element.attributes.partition, undefined);
  assert.equal(element.attributes.preload, undefined);
  assert.equal(element.attributes.webpreferences, undefined);
  assert.equal(guest.start(), guest.start(), 'start stays idempotent');
  assert.equal(mock.elements.length, 1);
  assert.equal(element.attributes.srcdoc, undefined);
  assert.equal('bridge' in mock, false, 'no Native bridge is consulted');
  for (const forbidden of ['nodeintegration', 'allowdownloads', 'disablewebsecurity']) {
    assert.equal(element.attributes[forbidden], undefined);
  }
  element.emit('load');
  element.emit('load');
  assert.equal(ready, 1);
  await guest.dispose();
});

test('the sandbox string is exactly script, same-origin, forms and modals', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  const sandbox = mock.elements[0].attributes.sandbox.split(/\s+/);
  assert.deepEqual(sandbox.sort(), ['allow-forms', 'allow-modals', 'allow-same-origin', 'allow-scripts']);
  for (const token of ['allow-popups', 'allow-downloads', 'allow-top-navigation', 'allow-pointer-lock']) {
    assert.equal(sandbox.includes(token), false);
  }
  await guest.dispose();
});

test('ready requires the assigned URL, is reported once, and focus follows visibility', async () => {
  const mock = harness();
  const ready = [];
  const guest = createBrowserGuest(options(mock, { onReady: () => ready.push(1) }));
  await guest.start();
  const element = mock.elements[0];
  const assigned = element.src;
  guest.focus();
  assert.equal(element.focusCalls, 0);
  element.src = 'http://127.0.0.1:4567/elsewhere';
  element.emit('load');
  assert.equal(ready.length, 0, 'a navigated-away frame is not the workspace');

  element.src = assigned;
  element.emit('load');
  assert.equal(ready.length, 1);
  guest.focus();
  assert.equal(element.focusCalls, 1);
  guest.setVisible(false);
  assert.equal(element.style.visibility, 'hidden');
  assert.equal(element.style.pointerEvents, 'none');
  guest.focus();
  assert.equal(element.focusCalls, 1);
  guest.setVisible(true);
  assert.equal(element.style.visibility, 'visible');
  assert.equal(element.style.pointerEvents, 'auto');
  element.isConnected = false;
  guest.focus();
  assert.equal(element.focusCalls, 1);
  await guest.dispose();
});

test('a frame error reports load failure, closes the guest, and never becomes ready', async () => {
  const mock = harness();
  const errors = [];
  const ready = [];
  const guest = createBrowserGuest(options(mock, {
    onError: (error) => errors.push(error),
    onReady: () => ready.push(1),
  }));
  await guest.start();
  const element = mock.elements[0];
  element.emit('error');
  await flush();
  assert.deepEqual(plain(errors), [{ code: 'BROWSER_GUEST_LOAD_FAILED' }]);
  assert.equal(ready.length, 0);
  assert.equal(element.removeCalls, 1);
  assert.equal(mock.container.children.length, 0);
  element.emit('load');
  assert.equal(ready.length, 0);
  await guest.dispose();
});

test('abort, dispose, and a late load all settle without ready or errors', async () => {
  const controller = new AbortController();
  const mock = harness();
  const errors = [];
  const ready = [];
  let lateListener;
  mock.document.createElement = (tag) => {
    assert.equal(tag, 'iframe');
    const element = new MockIframe();
    const add = element.addEventListener.bind(element);
    element.addEventListener = (name, listener) => { if (name === 'load') lateListener = listener; add(name, listener); };
    mock.elements.push(element);
    return element;
  };
  const guest = createBrowserGuest(options(mock, {
    signal: controller.signal,
    onError: (error) => errors.push(error),
    onReady: () => ready.push(1),
  }));
  await guest.start();
  const element = mock.elements[0];
  controller.abort();
  await guest.dispose();
  assert.equal(mock.container.children.length, 0);
  assert.equal(element.removeListenerCalls.includes('load'), true);
  lateListener();
  assert.equal(ready.length, 0);
  assert.equal(errors.length, 0);
});

test('an already-aborted signal never creates a frame', async () => {
  const controller = new AbortController();
  controller.abort();
  const mock = harness();
  const errors = [];
  const guest = createBrowserGuest(options(mock, { signal: controller.signal, onError: (error) => errors.push(error) }));
  await guest.start();
  assert.equal(mock.elements.length, 0);
  assert.equal(errors.length, 0);
  await guest.dispose();
});

test('a missing container reports a fixed code instead of throwing', async () => {
  const mock = harness();
  const errors = [];
  const guest = createBrowserGuest(options(mock, { container: null, onError: (error) => errors.push(error) }));
  await guest.start();
  assert.deepEqual(plain(errors), [{ code: 'BROWSER_GUEST_CONTAINER_UNAVAILABLE' }]);
  await guest.dispose();
});

test('a synchronous DOM failure reports the open error and leaves nothing attached', async () => {
  const mock = harness();
  mock.container.appendChild = () => { throw new Error('private container failure'); };
  const errors = [];
  const guest = createBrowserGuest(options(mock, { onError: (error) => errors.push(error) }));
  await guest.start();
  assert.deepEqual(plain(errors), [{ code: 'BROWSER_GUEST_OPEN_FAILED' }]);
  assert.equal(JSON.stringify(errors).includes('private'), false);
  await guest.dispose();
});

test('resize is a no-op and styling keeps the frame fluid', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  guest.resize();
  await guest.start();
  const element = mock.elements[0];
  assert.equal(guest.resize(), undefined);
  assert.deepEqual(element.style, {
    border: '0',
    display: 'block',
    height: '100%',
    minHeight: '0',
    minWidth: '0',
    pointerEvents: 'auto',
    visibility: 'visible',
    width: '100%',
  });
  await guest.dispose();
});

test('cwd replies are accepted only from the frame window, the guest origin, and the pending id', async () => {
  const mock = harness();
  const errors = [];
  const guest = createBrowserGuest(options(mock, { onError: (error) => errors.push(error) }));
  await guest.start();
  const element = mock.elements[0];
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.deepEqual(element.posts, undefined);
  element.emit('load');
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(element.posts.length, 1);
  const request = element.posts[0].message;
  assert.deepEqual(Object.keys(request).sort(), ['requestId', 'type', 'version']);
  assert.equal(request.type, 'workspace-shell-cwd-request');
  assert.equal(request.version, 1);
  assert.match(request.requestId, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(element.posts[0].targetOrigin, 'http://127.0.0.1:4567');

  const reply = (overrides) => mock.window.deliver({
    data: {
      type: 'workspace-shell-cwd-response',
      version: 1,
      requestId: request.requestId,
      cwd: '/effective',
      ...overrides.data,
    },
    origin: 'http://127.0.0.1:4567',
    source: element.contentWindow,
    ...overrides,
  });
  reply({ source: {} });
  reply({ origin: 'http://127.0.0.1:9999' });
  reply({ origin: 'http://127.0.0.1' });
  reply({ data: { requestId: 'stale-request-id-000' } });
  reply({ data: { type: 'workspace-shell-cwd-request' } });
  reply({ data: { version: 2 } });
  await flush();
  assert.equal(await Promise.race([reading, new Promise((resolve) => setTimeout(() => resolve('pending'), 30))]), 'pending');
  reply({});
  assert.equal(await reading, '/effective');
  assert.deepEqual(plain(errors), []);
  await guest.dispose();
});

test('missing, blank, non-string, oversized and NUL cwd values all resolve to null', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  element.emit('load');
  for (const cwd of [null, '', '   ', { path: '/object' }, 42, true, '/nul\u0000path', 'x'.repeat(4097)]) {
    const reading = guest.getWorkingDirectory();
    await flush();
    const request = element.posts.at(-1).message;
    mock.window.deliver({
      data: { type: 'workspace-shell-cwd-response', version: 1, requestId: request.requestId, cwd },
      origin: 'http://127.0.0.1:4567',
      source: element.contentWindow,
    });
    assert.equal(await reading, null, JSON.stringify(cwd));
  }
  const reading = guest.getWorkingDirectory();
  await flush();
  mock.window.deliver({
    data: { type: 'workspace-shell-cwd-response', version: 1, requestId: element.posts.at(-1).message.requestId, cwd: '/ok' },
    origin: 'http://127.0.0.1:4567',
    source: element.contentWindow,
  });
  assert.equal(await reading, '/ok');
  await guest.dispose();
});

test('the cwd request times out after one second and clears its timer', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  element.emit('load');
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(mock.window.timerCount, 1);
  mock.window.fireTimers();
  assert.equal(await reading, null);
  assert.equal(mock.window.timerCount, 0);
  await guest.dispose();
});

test('dispose removes the frame and the message listener, and no late reply can publish', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  element.emit('load');
  assert.equal(mock.window.listenerCount(), 1);
  const reading = guest.getWorkingDirectory();
  await flush();
  assert.equal(mock.window.listenerCount(), 1);
  const disposal = guest.dispose();
  mock.window.deliver({
    data: { type: 'workspace-shell-cwd-response', version: 1, requestId: element.posts.at(-1).message.requestId, cwd: '/late-cwd' },
    origin: 'http://127.0.0.1:4567',
    source: element.contentWindow,
  });
  assert.equal(await reading, null);
  await disposal;
  assert.equal(mock.window.listenerCount(), 0);
  assert.equal(element.removeCalls, 1);
  assert.equal(mock.container.children.length, 0);
  await guest.dispose();
  assert.equal(element.removeCalls, 1, 'dispose stays idempotent');
});

test('a guest that is not ready never posts a cwd request', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  const element = mock.elements[0];
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.deepEqual(element.posts, undefined);
  element.emit('load');
  element.src = 'http://127.0.0.1:4567/elsewhere';
  assert.equal(await guest.getWorkingDirectory(), null);
  await guest.dispose();
});

test('no cwd request is made without a parent origin or a UUID source', async () => {
  const bare = harness();
  bare.window.location = {};
  const bareGuest = createBrowserGuest(options(bare, { url: GUEST_URL }));
  await bareGuest.start();
  assert.equal(bare.elements.length, 0);
  assert.equal(await bareGuest.getWorkingDirectory(), null);
  await bareGuest.dispose();

  const mock = harness();
  mock.window.crypto = {};
  const guest = createBrowserGuest(options(mock));
  await guest.start();
  mock.elements[0].emit('load');
  assert.equal(await guest.getWorkingDirectory(), null);
  assert.deepEqual(mock.elements[0].posts, undefined);
  await guest.dispose();
});

test('an explicit parent origin overrides the window origin, and a bad one is ignored', async () => {
  const explicit = harness();
  const guest = createBrowserGuest(options(explicit, { parentOrigin: 'http://127.0.0.1:7777' }));
  await guest.start();
  assert.equal(new URL(explicit.elements[0].src).searchParams.get('workspaceShellParentOrigin'), 'http://127.0.0.1:7777');
  await guest.dispose();

  for (const parentOrigin of ['*', 'null', 'http://parent.example/private', 'javascript:alert(1)', 42, '']) {
    const mock = harness();
    const bad = createBrowserGuest(options(mock, { parentOrigin }));
    await bad.start();
    assert.equal(new URL(mock.elements[0].src).searchParams.get('workspaceShellParentOrigin'), PARENT_ORIGIN);
    await bad.dispose();
  }
});

test('consumer callback failures never break the guest lifecycle', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock, {
    onReady: () => { throw new Error('consumer ready failed'); },
    onError: () => { throw new Error('consumer error failed'); },
  }));
  await guest.start();
  const element = mock.elements[0];
  assert.doesNotThrow(() => element.emit('load'));
  assert.equal(mock.container.children.length, 1);
  assert.doesNotThrow(() => element.emit('error'));
  await flush();
  await guest.dispose();
});

test('guest notification frames reach the parent callback only from the assigned origin', async () => {
  const mock = harness();
  const events = [];
  const guest = createBrowserGuest(options(mock, { onGuestEvent: (data) => events.push(data) }));
  await guest.start();
  const element = mock.elements[0];
  element.emit('load');
  const data = {
    type: 'workspace-shell-notification', version: 1, event: 'turn-end', kind: 'turn-end',
    sessionId: 'a'.repeat(32), title: 'Release check', detail: '', viewing: false,
  };
  mock.window.deliver({ data, origin: 'https://evil.example', source: element.contentWindow });
  mock.window.deliver({ data, origin: 'http://127.0.0.1:4567', source: {} });
  mock.window.deliver({ data: { ...data, version: 2 }, origin: 'http://127.0.0.1:4567', source: element.contentWindow });
  assert.deepEqual(events, []);
  mock.window.deliver({ data, origin: 'http://127.0.0.1:4567', source: element.contentWindow });
  assert.deepEqual(events, [data]);
  await guest.dispose();
});

test('openSession posts one origin-targeted request and rejects unusable Session ids', async () => {
  const mock = harness();
  const guest = createBrowserGuest(options(mock));
  assert.equal(guest.openSession('a'.repeat(32)), false, 'a Guest that has not loaded cannot receive the request');
  await guest.start();
  const element = mock.elements[0];
  element.emit('load');
  const sessionId = 'a'.repeat(32);
  assert.equal(guest.openSession(sessionId), true);
  const posted = element.posts.at(-1);
  assert.equal(posted.message.type, 'workspace-shell-open-session');
  assert.equal(posted.message.version, 1);
  assert.equal(posted.message.sessionId, sessionId);
  assert.match(posted.message.requestId, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(posted.targetOrigin, 'http://127.0.0.1:4567');
  assert.equal(guest.openSession('../etc/passwd'), false);
  assert.equal(guest.openSession(''), false);
  await guest.dispose();
  assert.equal(guest.openSession(sessionId), false);
});
