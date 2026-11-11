import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostRestartControl } from '../../../packages/guest/src/host-restart-control.js';

const GLOBAL = '__workspaceShellRestartHost';
const MARKER = '__workspaceShellRestartControl';
const STATUS_PATH = '/api/workspace-host/status';
const RESTART_PATH = '/api/workspace-host/restart';
const REQUEST_TYPE = 'workspace-shell-host-restart-request';
const RESPONSE_TYPE = 'workspace-shell-host-restart-response';
const PARENT_ORIGIN = 'http://127.0.0.1:64016';
const REQUEST_ID = 'ab12_cd34-EF56'.repeat(2);
const EMBEDDED = '?workspaceShellEmbedded=1';
const FRAMED = '?workspaceShellParentOrigin=' + encodeURIComponent(PARENT_ORIGIN);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function jsonResponse(payload, ok = true) {
  return { ok, status: ok ? 200 : 500, async json() { return payload; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function node(tag) {
  const element = {
    tag,
    style: { cssText: '' },
    attrs: {},
    children: [],
    textContent: '',
    removed: 0,
    setAttribute(name, value) { element.attrs[name] = String(value); },
    appendChild(child) { element.children.push(child); return child; },
    remove() { element.removed += 1; },
    get firstChild() { return element.children[0] ?? null; },
  };
  return element;
}

/**
 * A fake Guest window/document. Timers never fire on their own; runTimer(id)
 * runs one, so the restart flow never waits on real time.
 */
function harness({ search = '', hash = '', framed = false, lang = 'zh', fetchImpl } = {}) {
  const listeners = new Set();
  const timers = new Map();
  let timerSeq = 0;
  let uuidSeq = 0;
  const cleared = [];
  const requested = [];
  const posted = [];
  const appended = [];
  const reloads = [];
  const requestedSelf = [];
  const parent = { postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); } };
  const respond = fetchImpl ?? (async (path) => {
    if (path === STATUS_PATH) return jsonResponse({ ok: true, supervised: false, allowRestart: true, busy: { tasks: 0, jobs: 0 } });
    return jsonResponse({ ok: true });
  });
  const window = {
    location: { search, hash, reload() { reloads.push(Date.now()); } },
    parent: framed ? parent : null,
    fetch(path, options) { requested.push({ path, options }); return respond(path, options); },
    setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { cleared.push(id); timers.delete(id); },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(message, targetOrigin) { requestedSelf.push({ message, targetOrigin }); },
    crypto: { randomUUID: () => 'uuid-' + (++uuidSeq) },
  };
  if (!framed) window.parent = window;
  const document = {
    documentElement: { getAttribute: (name) => (name === 'lang' ? lang : null) },
    body: { appendChild(child) { appended.push(child); } },
    createElement: (tag) => node(tag),
  };
  const control = createHostRestartControl({ window, document });
  function deliver(event) { for (const listener of [...listeners]) listener(event); }
  async function runTimer(id) {
    const entry = timers.get(id);
    assert.ok(entry, `timer ${id} should be pending`);
    timers.delete(id);
    await entry.fn();
  }
  return {
    window, document, control, parent, listeners, timers, cleared, requests: requested,
    requestedSelf, posted, appended, reloads, deliver, runTimer,
    overlay: () => appended.find((element) => 'data-workspace-restart' in element.attrs),
    pending: () => [...timers.entries()],
  };
}

function request(requestId = REQUEST_ID, overrides = {}) {
  return {
    type: REQUEST_TYPE,
    version: 1,
    requestId,
    mode: 'wait',
    ...overrides,
  };
}

function status(overrides = {}) {
  return jsonResponse({ ok: true, supervised: false, allowRestart: true, busy: { tasks: 0, jobs: 0 }, ...overrides });
}

test('a page that is not embedded installs nothing', () => {
  const h = harness();
  h.control.apply();
  assert.equal(GLOBAL in h.window, false);
  assert.equal(MARKER in h.window, false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.requests.length, 0);
});

test('the embedded flag in the hash installs the webview global too', () => {
  const h = harness({ hash: '#workspaceShellEmbedded=1' });
  h.control.apply();
  assert.equal(typeof h.window[GLOBAL], 'function');
});

test('the webview global restarts an idle Host, paints the overlay and schedules the recovery poll', async () => {
  const h = harness({ search: EMBEDDED, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.equal(typeof h.window[GLOBAL], 'function');

  assert.deepEqual(await h.window[GLOBAL]('wait'), { ok: true });
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH, RESTART_PATH]);
  assert.deepEqual(h.requests[0].options, { credentials: 'same-origin', cache: 'no-store' });
  assert.equal(h.requests[1].options.method, 'POST');
  assert.equal(h.requests[1].options.credentials, 'same-origin');
  assert.equal(h.requests[1].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { mode: 'wait', force: false });

  const overlay = h.overlay();
  assert.equal(overlay.attrs['data-workspace-restart'], '');
  assert.equal(overlay.style.cssText.startsWith('position:fixed'), true);
  assert.equal(overlay.children.length, 1);
  assert.match(overlay.children[0].textContent, /正在重启/u);

  const pending = h.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0][1].ms, 2000);
});

test('an English document gets the English overlay text', async () => {
  const h = harness({ search: EMBEDDED, lang: 'en-US', fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('wait'), { ok: true });
  assert.match(h.overlay().children[0].textContent, /Restarting/u);
});

test('restart now forces the restart when the Host is busy', async () => {
  const h = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => (path === STATUS_PATH ? status({ busy: { tasks: 1, jobs: 2 } }) : jsonResponse({ ok: true })),
  });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('now'), { ok: true });
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { mode: 'now', force: true });
});

test('restart now leaves force off when the Host is idle', async () => {
  const h = harness({ search: EMBEDDED, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('now'), { ok: true });
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { mode: 'now', force: false });
});

test('restart wait never forces a busy Host', async () => {
  const h = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => (path === STATUS_PATH ? status({ busy: { tasks: 3, jobs: 0 } }) : jsonResponse({ ok: true })),
  });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('wait'), { ok: true });
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { mode: 'wait', force: false });
});

test('a supervised Host refuses the restart without POSTing', async () => {
  const h = harness({ search: EMBEDDED, fetchImpl: async (path) => (path === STATUS_PATH ? status({ supervised: true }) : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('now'), { ok: false, code: 'HOST_RESTART_SUPERVISED' });
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH]);
  assert.equal(h.overlay(), undefined);
  assert.equal(h.pending().length, 0);
});

test('a Host with restarts disabled refuses without POSTing', async () => {
  const h = harness({ search: EMBEDDED, fetchImpl: async (path) => (path === STATUS_PATH ? status({ allowRestart: false }) : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('wait'), { ok: false, code: 'HOST_RESTART_DISABLED' });
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH]);
  assert.equal(h.overlay(), undefined);
});

test('a failed status request surfaces its code and never posts the restart', async () => {
  const refused = harness({
    search: EMBEDDED,
    fetchImpl: async () => jsonResponse({ ok: false, code: 'HOST_STATUS_UNAVAILABLE' }, false),
  });
  refused.control.apply();
  assert.deepEqual(await refused.window[GLOBAL]('now'), { ok: false, code: 'HOST_STATUS_UNAVAILABLE' });
  assert.deepEqual(refused.requests.map((entry) => entry.path), [STATUS_PATH]);
  assert.equal(refused.overlay(), undefined);

  const offline = harness({ search: EMBEDDED, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  offline.control.apply();
  assert.deepEqual(await offline.window[GLOBAL]('wait'), { ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
  assert.equal(offline.requests.length, 1);
  assert.equal(offline.pending().length, 0);
});

test('an unknown mode is rejected before any request', async () => {
  const h = harness({ search: EMBEDDED });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('later'), { ok: false, code: 'HOST_RESTART_INVALID_MODE' });
  assert.deepEqual(await h.window[GLOBAL](undefined), { ok: false, code: 'HOST_RESTART_INVALID_MODE' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.overlay(), undefined);
});

test('a refused restart POST returns its code and paints no overlay', async () => {
  const h = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: false, code: 'HOST_RESTART_BUSY' }, false)),
  });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('now'), { ok: false, code: 'HOST_RESTART_BUSY' });
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH, RESTART_PATH]);
  assert.equal(h.overlay(), undefined);
  assert.equal(h.pending().length, 0);
});

test('an unusable failure payload falls back to HOST_RESTART_UNAVAILABLE', async () => {
  const badCode = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: false, code: 'not a code' })),
  });
  badCode.control.apply();
  assert.deepEqual(await badCode.window[GLOBAL]('wait'), { ok: false, code: 'HOST_RESTART_UNAVAILABLE' });

  const broken = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => {
      if (path === STATUS_PATH) return status();
      return { ok: false, status: 502, async json() { throw new SyntaxError('not json'); } };
    },
  });
  broken.control.apply();
  assert.deepEqual(await broken.window[GLOBAL]('wait'), { ok: false, code: 'HOST_RESTART_UNAVAILABLE' });

  const offline = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => {
      if (path === STATUS_PATH) return status();
      throw new TypeError('fetch failed');
    },
  });
  offline.control.apply();
  assert.deepEqual(await offline.window[GLOBAL]('wait'), { ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
});

test('a second call while the first is still running reports HOST_RESTART_IN_PROGRESS', async () => {
  const gate = deferred();
  const h = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => (path === STATUS_PATH ? gate.promise : jsonResponse({ ok: true })),
  });
  h.control.apply();
  const first = h.window[GLOBAL]('wait');
  // Race a sentinel so a missing in-progress guard fails instead of hanging on the gate.
  const second = await Promise.race([h.window[GLOBAL]('now'), Promise.resolve('NO_GUARD')]);
  assert.deepEqual(second, { ok: false, code: 'HOST_RESTART_IN_PROGRESS' });
  gate.resolve(status());
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH, RESTART_PATH]);
});

test('the iframe channel answers a valid parent request on the declared origin', async () => {
  const h = harness({ search: FRAMED, framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.equal(h.listeners.size, 1);
  assert.equal(GLOBAL in h.window, false);

  h.deliver({ source: h.parent, origin: PARENT_ORIGIN, data: request() });
  await flush();
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.posted[0].message, {
    type: RESPONSE_TYPE, version: 1, requestId: REQUEST_ID, ok: true,
  });
  assert.equal(h.posted[0].targetOrigin, PARENT_ORIGIN);
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH, RESTART_PATH]);
  assert.equal(h.overlay().attrs['data-workspace-restart'], '');
});

test('the iframe channel forwards the failure code to the parent', async () => {
  const h = harness({ search: FRAMED, framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status({ allowRestart: false }) : jsonResponse({ ok: true })) });
  h.control.apply();
  h.deliver({ source: h.parent, origin: PARENT_ORIGIN, data: request(REQUEST_ID, { mode: 'now' }) });
  await flush();
  assert.deepEqual(h.posted[0].message, {
    type: RESPONSE_TYPE, version: 1, requestId: REQUEST_ID, ok: false, code: 'HOST_RESTART_DISABLED',
  });
  assert.equal(h.posted[0].targetOrigin, PARENT_ORIGIN);
});

test('a request from the wrong source or origin is ignored', async () => {
  const h = harness({ search: FRAMED, framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();

  h.deliver({ source: {}, origin: PARENT_ORIGIN, data: request() });
  h.deliver({ source: h.window, origin: PARENT_ORIGIN, data: request() });
  h.deliver({ source: h.parent, origin: 'https://evil.example:8443', data: request() });
  h.deliver({ source: h.parent, origin: 'null', data: request() });
  await flush();

  assert.equal(h.requests.length, 0);
  assert.equal(h.posted.length, 0);
});

test('malformed parent frames are ignored', async () => {
  const h = harness({ search: FRAMED, framed: true });
  h.control.apply();
  const source = h.parent;
  const origin = PARENT_ORIGIN;
  for (const data of [
    null,
    'restart',
    [],
    request(REQUEST_ID, { type: 'workspace-shell-cwd-request' }),
    request(REQUEST_ID, { version: 2 }),
    request(REQUEST_ID, { requestId: 'short' }),
    request(REQUEST_ID, { requestId: 'x'.repeat(129) }),
    request(REQUEST_ID, { mode: 'immediately' }),
  ]) {
    h.deliver({ source, origin, data });
  }
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.posted.length, 0);
});

test('a repeated requestId is handled once', async () => {
  const h = harness({ search: FRAMED, framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  const event = { source: h.parent, origin: PARENT_ORIGIN, data: request() };
  h.deliver(event);
  h.deliver(event);
  h.deliver({ ...event, data: request() });
  await flush();
  assert.deepEqual(h.requests.map((entry) => entry.path), [STATUS_PATH, RESTART_PATH]);
  assert.equal(h.posted.length, 1);
  assert.equal(h.requestedSelf.length, 0);
});

test('a framed page without a parent-origin parameter pins the first valid origin', async () => {
  const h = harness({ framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  const first = 'http://127.0.0.1:59919';
  h.deliver({ source: h.parent, origin: first, data: request() });
  await flush();
  assert.equal(h.posted[0].targetOrigin, first);
  h.deliver({ source: h.parent, origin: 'https://evil.example:8443', data: request('zz'.repeat(8)) });
  await flush();
  assert.equal(h.posted.length, 1);
  assert.equal(h.requests.length, 2);
});

test('the recovery poll probes GET / and reloads once the Host answers', async () => {
  const polled = [];
  const h = harness({
    search: EMBEDDED,
    fetchImpl: async (path) => {
      if (path === STATUS_PATH) return status();
      if (path === RESTART_PATH) return jsonResponse({ ok: true });
      polled.push(path);
      return jsonResponse({ ok: true });
    },
  });
  h.control.apply();
  assert.deepEqual(await h.window[GLOBAL]('now'), { ok: true });

  const [pollId, poll] = h.pending()[0];
  assert.equal(poll.ms, 2000);
  await h.runTimer(pollId);
  assert.deepEqual(polled, ['/']);
  assert.deepEqual(h.requests.at(-1).options, { cache: 'no-store', credentials: 'same-origin' });

  const [reloadId, reload] = h.pending()[0];
  assert.equal(reload.ms, 1200);
  await h.runTimer(reloadId);
  assert.equal(h.reloads.length, 1);
});

test('dispose clears the webview global, the overlay and the timers, and is idempotent', async () => {
  const h = harness({ search: EMBEDDED, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  let disposer = null;
  const ctx = { effect(setup, label) { assert.equal(label, 'workspace guest host restart'); disposer = setup(); return disposer; } };
  h.control.apply(ctx);
  assert.equal(typeof h.window[GLOBAL], 'function');
  assert.equal(h.window[MARKER], true);

  assert.deepEqual(await h.window[GLOBAL]('wait'), { ok: true });
  const overlay = h.overlay();
  const [timerId] = h.pending()[0];

  assert.equal(typeof disposer, 'function');
  disposer();
  assert.equal(GLOBAL in h.window, false);
  assert.equal(MARKER in h.window, false);
  assert.equal(overlay.removed, 1);
  assert.deepEqual(h.cleared, [timerId]);
  assert.equal(h.pending().length, 0);

  h.control.dispose();
  assert.equal(overlay.removed, 1);
  assert.equal(h.cleared.length, 1);
  assert.equal(h.window[GLOBAL], undefined);
});

test('dispose detaches the iframe channel and stops answering the parent', async () => {
  const h = harness({ search: FRAMED, framed: true, fetchImpl: async (path) => (path === STATUS_PATH ? status() : jsonResponse({ ok: true })) });
  h.control.apply();
  assert.equal(h.listeners.size, 1);
  h.deliver({ source: h.parent, origin: PARENT_ORIGIN, data: request() });
  await flush();
  assert.equal(h.posted.length, 1);

  h.control.dispose();
  assert.equal(h.listeners.size, 0);
  assert.equal(MARKER in h.window, false);
  h.deliver({ source: h.parent, origin: PARENT_ORIGIN, data: request('yz'.repeat(8)) });
  await flush();
  assert.equal(h.posted.length, 1);
  assert.equal(h.requests.length, 2);
});

test('a control disposed before apply installs nothing and dispose stays idempotent', () => {
  const h = harness({ search: EMBEDDED });
  h.control.dispose();
  h.control.apply();
  h.control.dispose();
  assert.equal(GLOBAL in h.window, false);
  assert.equal(MARKER in h.window, false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.requests.length, 0);
});
