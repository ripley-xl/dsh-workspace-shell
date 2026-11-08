import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerShellRoutes } from '../../packages/shell/src/host/routes.js';
import { registerWorkspaceRuntimeTool } from '../../packages/shell/src/host/runtime-tool.js';

const PREFIX = '/api/workspace-shell';
const SECRET = 'private-token-never-appear';
const POST_ROUTES = [
  '/catalog', '/web/open', '/web/attach', '/tui/open', '/terminal/read', '/terminal/write', '/terminal/resize', '/runtime/stop', '/runtime/close-owner',
  '/tab-order/get', '/tab-order/set',
];
const GET_ROUTES = ['/terminal', '/assets/xterm.js', '/assets/addon-fit.js', '/assets/terminal-document.js', '/assets/xterm.css'];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeService(overrides = {}) {
  const calls = [];
  const record = (method, input, result) => {
    calls.push({ method, input });
    return result;
  };
  return {
    calls,
    async catalog(input) { return record('catalog', input, { currentProfile: 'current', defaultCwd: '/work/default', profiles: [], runtimes: [] }); },
    async openWeb(input) { return record('openWeb', input, { runtimeId: 'runtime-web' }); },
    async attachWeb(input) { return record('attachWeb', input, { runtimeId: 'runtime-web' }); },
    async openTui(input) { return record('openTui', input, { runtimeId: 'runtime-tui' }); },
    async readTerminal(input) { return record('readTerminal', input, { chunks: [], firstSeq: 0, nextSeq: 0, loss: false, phase: 'running' }); },
    async writeTerminal(input) { return record('writeTerminal', input); },
    async resizeTerminal(input) { return record('resizeTerminal', input); },
    async stop(input) { return record('stop', input); },
    ...overrides,
  };
}

function routeContext(service, { failAt = 0, release } = {}) {
  const routes = new Map();
  const released = [];
  let count = 0;
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          count += 1;
          if (count === failAt) throw new Error(`private registration failure ${SECRET}`);
          assert.equal(routes.has(route.path), false);
          routes.set(route.path, route);
          return async () => {
            released.push(route.path);
            await release?.(route);
            routes.delete(route.path);
          };
        },
      },
    },
  };
  return { ctx, routes, released };
}

function setup(t, { service = fakeService(), assetRoot, failAt, release, tabOrder } = {}) {
  const state = routeContext(service, { failAt, release });
  const dispose = registerShellRoutes(state.ctx, service, {
    ...(assetRoot ? { assetRoot } : {}),
    ...(tabOrder === undefined ? {} : { tabOrder }),
  });
  t.after(async () => { await dispose().catch(() => {}); });
  return { ...state, service, dispose, tabOrder };
}

function fakeTabOrder(initial = []) {
  const calls = [];
  let order = [...initial];
  return {
    calls,
    get order() { return order; },
    async read() { calls.push('read'); return [...order]; },
    async write(next) { calls.push('write'); order = [...next]; return true; },
  };
}

async function call(state, suffix, { method = 'POST', input, raw, headers = {}, signal, onRequest } = {}) {
  const route = state.routes.get(PREFIX + suffix);
  if (!route) return new Response('Not found', { status: 404 });
  assert.equal(route.methods.includes(method), true);
  const body = method === 'POST' ? (raw !== undefined ? raw : JSON.stringify(input ?? {})) : undefined;
  const request = new Request(`http://localhost${PREFIX}${suffix}`, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
    ...(signal ? { signal } : {}),
  });
  onRequest?.(request);
  return route.fetch(request);
}

async function responseJson(response) {
  return response.json();
}

test('registers exactly sixteen routes with the real connection method/body contract', async (t) => {
  const state = setup(t);
  assert.deepEqual([...state.routes.keys()].sort(), [...POST_ROUTES, ...GET_ROUTES].map((path) => PREFIX + path).sort());
  for (const path of POST_ROUTES) {
    assert.deepEqual(state.routes.get(PREFIX + path).methods, ['POST']);
    assert.equal(state.routes.get(PREFIX + path).requestBody, 'streaming');
  }
  for (const path of GET_ROUTES) {
    assert.deepEqual(state.routes.get(PREFIX + path).methods, ['GET']);
    assert.equal(state.routes.get(PREFIX + path).requestBody, 'buffered');
  }
  await state.dispose();
  assert.equal(state.routes.size, 0);
});

test('POST routes project known kwargs and preserve the Request signal instead of a body signal', async (t) => {
  const state = setup(t);
  const controller = new AbortController();
  const cases = [
    ['/catalog', { ownerId: 'owner' }],
    ['/web/open', { profileId: 'web', ownerId: 'owner', confirmIndependentHost: 'true', signal: SECRET }, controller.signal],
    ['/web/attach', { runtimeId: 'runtime-web', ownerId: 'owner' }],
    ['/tui/open', { profileId: 'tui', ownerId: 'owner', cwd: '/work', cols: 80, rows: 24, confirmIndependentHost: true }],
    ['/terminal/read', { runtimeId: 'runtime-tui', ownerId: 'owner', afterSeq: 4 }],
    ['/terminal/write', { runtimeId: 'runtime-tui', ownerId: 'owner', data: 'abc' }],
    ['/terminal/resize', { runtimeId: 'runtime-tui', ownerId: 'owner', cols: 120, rows: 40 }],
    ['/runtime/stop', { runtimeId: 'runtime-tui', ownerId: 'owner' }],
  ];
  let actualRequestSignal;
  for (const [suffix, input, signal] of cases) {
    const response = await call(state, suffix, {
      input: { ...input, unknownKwarg: SECRET },
      ...(signal ? { signal, onRequest: (request) => { actualRequestSignal = request.signal; } } : {}),
    });
    assert.equal(response.status, 200);
    assert.equal((await responseJson(response)).ok, true);
  }
  assert.deepEqual(state.service.calls.map((call) => call.method), ['catalog', 'openWeb', 'attachWeb', 'openTui', 'readTerminal', 'writeTerminal', 'resizeTerminal', 'stop']);
  for (const call of state.service.calls) assert.equal('unknownKwarg' in call.input, false);
  const open = state.service.calls[1].input;
  assert.equal(open.signal, actualRequestSignal);
  assert.equal(open.signal === actualRequestSignal, true);
  assert.equal(open.confirmIndependentHost, false);
  assert.equal('unknownKwarg' in open, false);
  assert.equal(open.signal?.aborted, false);
});

test('JSON content type is required and malformed or non-object bodies fail without diagnostics', async (t) => {
  const state = setup(t);
  for (const options of [
    { raw: '{}', headers: { 'content-type': 'text/plain' } },
    { raw: '{"' },
    { raw: '[]' },
    { raw: 'null' },
  ]) {
    const response = await call(state, '/catalog', options);
    assert.equal(response.status, 400);
    assert.deepEqual(await responseJson(response), { ok: false, error: { code: 'INVALID_INPUT' } });
  }
  const accepted = await call(state, '/catalog', { raw: '{}', headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(accepted.status, 200);
  assert.equal(state.service.calls.length, 1);
});

test('the 128 KiB body cap rejects both declared and streaming oversized bodies before service dispatch', async (t) => {
  const state = setup(t);
  const declared = await call(state, '/catalog', { raw: `{"data":"${'x'.repeat(128 * 1024)}"}` });
  assert.equal(declared.status, 413);
  assert.deepEqual(await responseJson(declared), { ok: false, error: { code: 'REQUEST_TOO_LARGE' } });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024 + 1));
      controller.close();
    },
  });
  const request = new Request(`http://localhost${PREFIX}/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
  });
  const response = await state.routes.get(`${PREFIX}/catalog`).fetch(request);
  assert.equal(response.status, 413);
  assert.deepEqual(await responseJson(response), { ok: false, error: { code: 'REQUEST_TOO_LARGE' } });
  assert.equal(state.service.calls.length, 0);
});

test('service failures expose only allowlisted codes and never messages, causes, or tokens', async (t) => {
  const safeFailure = Object.assign(new Error(`unsafe detail ${SECRET}`), { code: 'WEB_STARTUP_FAILED', safe: true, cause: new Error(SECRET) });
  const state = setup(t, {
    service: fakeService({
      async openWeb() { throw safeFailure; },
      async stop() { throw Object.assign(new Error(SECRET), { code: 'RUNTIME_OWNER_MISMATCH', safe: true }); },
    }),
  });
  const failed = await call(state, '/web/open', { input: { profileId: 'web', ownerId: 'owner' } });
  assert.equal(failed.status, 400);
  assert.deepEqual(await responseJson(failed), { ok: false, error: { code: 'WEB_STARTUP_FAILED' } });
  const forbidden = await call(state, '/runtime/stop', { input: { runtimeId: 'runtime-web', ownerId: 'owner' } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await responseJson(forbidden), { ok: false, error: { code: 'RUNTIME_OWNER_MISMATCH' } });

  const unknown = setup(t, { service: fakeService({ async openWeb() { throw new Error(SECRET, { cause: SECRET }); } }) });
  const response = await call(unknown, '/web/open', { input: { profileId: 'web', ownerId: 'owner' } });
  assert.equal(response.status, 500);
  assert.deepEqual(await responseJson(response), { ok: false, error: { code: 'WORKSPACE_REQUEST_FAILED' } });
  assert.equal(JSON.stringify(response).includes(SECRET), false);
});

test('the terminal document uses fixed self assets, a restrictive CSP, and no runtime or owner data', async (t) => {
  const state = setup(t);
  const response = await call(state, '/terminal', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /script-src 'self'/u);
  assert.match(csp, /connect-src 'none'/u);
  assert.match(csp, /frame-ancestors 'self'/u);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]), [
    `${PREFIX}/assets/xterm.js`, `${PREFIX}/assets/addon-fit.js`, `${PREFIX}/assets/terminal-document.js`,
  ]);
  assert.ok(html.includes(`<link rel="stylesheet" href="${PREFIX}/assets/xterm.css"`));
  for (const value of ['ownerId', 'runtimeId', 'authenticatedUrl', SECRET, 'http://', 'https://']) assert.equal(html.includes(value), false);
});

test('assets use a four-file whitelist, fixture content, and a safe 503 for missing files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-shell-routes-'));
  t.after(async () => {
    assert.equal(root.startsWith(path.join(tmpdir(), 'dsh-shell-routes-')), true);
    await rm(root, { recursive: true, force: true });
  });
  const files = {
    'xterm.js': 'xterm fixture', 'addon-fit.js': 'fit fixture', 'terminal-document.js': 'terminal fixture', 'xterm.css': '.xterm {}',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const state = setup(t, { assetRoot: pathToFileURL(root + path.sep) });
  for (const [name, content] of Object.entries(files)) {
    const response = await call(state, `/assets/${name}`, { method: 'GET' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
    assert.match(response.headers.get('content-type'), name.endsWith('.css') ? /^text\/css/u : /^text\/javascript/u);
  }
  await rm(path.join(root, 'xterm.js'));
  const missing = await call(state, '/assets/xterm.js', { method: 'GET' });
  assert.equal(missing.status, 503);
  assert.equal(await missing.text(), 'Asset unavailable');
  const unregistered = await call(state, '/assets/secret.js', { method: 'GET' });
  assert.equal(unregistered.status, 404);
});

test('close-owner stops only explicitly enumerated stoppable owned active TUI runtimes', async (t) => {
  const runtimes = [
    { id: 'owned-running', kind: 'tui', phase: 'running', canStop: true },
    { id: 'owned-starting', kind: 'tui', phase: 'starting', canStop: true },
    { id: 'owned-stopping', kind: 'tui', phase: 'stopping', canStop: true },
    { id: 'owned-unlisted', kind: 'tui', phase: 'running', canStop: true },
    { id: 'web', kind: 'web', phase: 'running', canStop: true },
    { id: 'foreign', kind: 'tui', phase: 'running', canStop: false },
    { id: 'external', kind: 'tui', phase: 'running', canStop: false },
    { id: 'current-local', kind: 'tui', phase: 'running', canStop: false },
    { id: 'exited', kind: 'tui', phase: 'exited', canStop: true },
    { id: 'failed', kind: 'tui', phase: 'failed', canStop: true },
  ];
  const service = fakeService({ async catalog(input) { service.calls.push({ method: 'catalog', input }); return { runtimes }; } });
  const state = setup(t, { service });
  const response = await call(state, '/runtime/close-owner', { input: {
    ownerId: 'owner',
    runtimeIds: ['owned-running', 'owned-starting', 'owned-stopping', 'web', 'foreign', 'external', 'current-local', 'exited', 'failed'],
  } });
  assert.equal(response.status, 200);
  assert.deepEqual((await responseJson(response)).result, { stopped: 3 });
  assert.deepEqual(service.calls.filter((call) => call.method === 'stop').map((call) => [call.input.runtimeId, call.input.ownerId]), [
    ['owned-running', 'owner'], ['owned-starting', 'owner'], ['owned-stopping', 'owner'],
  ]);
});

test('close-owner rejects missing or invalid runtimeIds before reading the catalog', async (t) => {
  const state = setup(t);
  const invalidValues = [undefined, null, 'runtime-1', [1], ['bad/id'], Array.from({ length: 1025 }, (_, index) => `runtime-${index}`)];
  for (const runtimeIds of invalidValues) {
    const response = await call(state, '/runtime/close-owner', { input: { ownerId: 'owner', ...(runtimeIds !== undefined ? { runtimeIds } : {}) } });
    assert.equal(response.status, 400);
    assert.deepEqual(await responseJson(response), { ok: false, error: { code: 'INVALID_INPUT' } });
  }
  assert.equal(state.service.calls.length, 0);
});

test('tab-order routes read and write one bounded identity list', async (t) => {
  const tabOrder = fakeTabOrder(['local', 'web:alpha']);
  const state = setup(t, { tabOrder });
  const read = await call(state, '/tab-order/get', { input: {} });
  assert.equal(read.status, 200);
  assert.deepEqual(await responseJson(read), { ok: true, result: { order: ['local', 'web:alpha'] } });
  const write = await call(state, '/tab-order/set', { input: { order: ['web:alpha', 'local'] } });
  assert.equal(write.status, 200);
  assert.deepEqual(await responseJson(write), { ok: true, result: { saved: true } });
  assert.deepEqual(tabOrder.calls, ['read', 'write']);
  assert.deepEqual(tabOrder.order, ['web:alpha', 'local']);
  for (const order of [undefined, 'x', [1], ['bad token'], Array.from({ length: 65 }, (_, index) => `t${index}`)]) {
    const response = await call(state, '/tab-order/set', { input: order === undefined ? {} : { order } });
    assert.equal(response.status, 400);
    assert.deepEqual(await responseJson(response), { ok: false, error: { code: 'INVALID_INPUT' } });
  }
  assert.equal(tabOrder.calls.filter((entry) => entry === 'write').length, 1);
});

test('tab-order stays optional and reports unsaved writes without failing tab creation', async (t) => {
  const state = setup(t);
  const read = await call(state, '/tab-order/get', { input: {} });
  assert.equal(read.status, 200);
  assert.deepEqual(await responseJson(read), { ok: true, result: { order: [] } });
  const write = await call(state, '/tab-order/set', { input: { order: ['local'] } });
  assert.equal(write.status, 200);
  assert.deepEqual(await responseJson(write), { ok: true, result: { saved: false } });

  const failing = setup(t, { tabOrder: { async read() { return []; }, async write() { return false; } } });
  const unsaved = await call(failing, '/tab-order/set', { input: { order: ['local'] } });
  assert.deepEqual(await responseJson(unsaved), { ok: true, result: { saved: false } });
});

test('dispose is idempotent, awaits asynchronous unregister, and removes every route', async (t) => {
  const first = deferred();
  const second = deferred();
  let firstFinished = false;
  let secondFinished = false;
  const state = routeContext(fakeService(), {
    release: async (route) => {
      if (route.path.endsWith('/catalog')) { await first.promise; firstFinished = true; }
      if (route.path.endsWith('/web/open')) { await second.promise; secondFinished = true; }
    },
  });
  const dispose = registerShellRoutes(state.ctx, fakeService());
  const pending = dispose();
  assert.equal(dispose(), pending);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.released.length, 16);
  assert.equal(firstFinished, false);
  assert.equal(secondFinished, false);
  first.resolve();
  second.resolve();
  await pending;
  assert.equal(firstFinished, true);
  assert.equal(secondFinished, true);
  assert.equal(state.routes.size, 0);
  await dispose();
  assert.equal(state.released.length, 16);
});

test('one rejected unregister does not block other cleanup or leak its error', async (t) => {
  const state = routeContext(fakeService(), {
    release: async (route) => { if (route.path.endsWith('/catalog')) throw new Error(SECRET); },
  });
  const dispose = registerShellRoutes(state.ctx, fakeService());
  await assert.rejects(dispose(), (error) => {
    assert.equal(error.code, 'WORKSPACE_ROUTE_DISPOSE_FAILED');
    assert.equal(error.message, 'WORKSPACE_ROUTE_DISPOSE_FAILED');
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return true;
  });
  assert.equal(state.released.length, 16);
  assert.equal(state.routes.size, 1);
  assert.equal(state.routes.has(`${PREFIX}/catalog`), true);
});

test('partial registration failure asynchronously cleans every route already registered', async () => {
  const state = routeContext(fakeService(), { failAt: 4 });
  assert.throws(() => registerShellRoutes(state.ctx, fakeService()), (error) => {
    assert.equal(error.code, 'WORKSPACE_ROUTES_UNAVAILABLE');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.released.length, 3);
  assert.equal(state.routes.size, 0);
});

test('workspace_runtime instantiates through the real dsh-tools defineTool SDK', async () => {
  let definition;
  let middleware;
  const cleanup = { tool: 0, middleware: 0 };
  const ctx = {
    on(name, listener) {
      assert.equal(name, 'tools/pre-execute');
      middleware = listener;
      return () => { cleanup.middleware += 1; };
    },
    tools: {
      register(value) {
        definition = value;
        return () => { cleanup.tool += 1; };
      },
    },
  };
  const service = fakeService();
  const unregister = registerWorkspaceRuntimeTool(ctx, service, { defineTool });
  assert.equal(definition.name, 'workspace_runtime');
  assert.equal(definition.parameters.type, 'object');
  assert.deepEqual(definition.parameters.required, ['operation']);
  assert.deepEqual(definition.parameters.properties.operation.enum, ['list', 'start_web', 'start_tui', 'stop']);
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  const value = await definition.execute({ operation: 'list' }, { agent: { id: '12345678-1234-4234-9234-123456789012' }, signal: new AbortController().signal });
  assert.equal(value.status, 'ok');
  assert.equal(value.operation, 'list');
  assert.equal(typeof middleware, 'function');
  const decision = await middleware({ name: 'workspace_runtime', arguments: { operation: 'stop', id: 'runtime-1' } }, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask');
  unregister();
  unregister();
  assert.deepEqual(cleanup, { tool: 1, middleware: 1 });
});
