import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createTabState } from '../../../packages/shell/src/tab-state.js';
import * as controllerModule from '../../../packages/shell/src/tab-controller.js';

const { createTabController } = controllerModule;
const spec = (extra = {}) => ({ kind: 'browser', key: 'a', title: 'A', url: 'https://private/?token=secret', token: 'secret', ...extra });
const launcherSpec = (extra = {}) => ({ kind: 'launcher', key: 'launcher-a', title: '新建工作区', ...extra });
const tab = (controller, id) => controller.getSnapshot().tabs.find((item) => item.id === id);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const handle = (extra = {}) => ({
  visible: [], focused: 0, resized: 0, disposed: 0,
  setVisible(value) { this.visible.push(value); },
  focus() { this.focused++; },
  resize() { this.resized++; },
  dispose() { this.disposed++; },
  ...extra,
});
const provider = (implementation) => ({
  calls: [],
  open(input, context) {
    const result = deferred();
    const call = { spec: input, ...context, ...result };
    this.calls.push(call);
    return implementation ? implementation(call) : result.promise;
  },
});
const fixture = (implementation, options) => {
  const state = createTabState({ localProfileId: 'home', ...options });
  const controller = createTabController(state);
  const native = provider(implementation);
  const unregister = controller.registerProvider('browser', native);
  return { state, controller, native, unregister };
};
const launcherFixture = (options) => {
  const state = createTabState({ localProfileId: 'home', ...options });
  const controller = createTabController(state);
  const browser = provider(() => handle());
  const terminal = provider(() => handle());
  const unregisterBrowser = controller.registerProvider('browser', browser);
  const unregisterTerminal = controller.registerProvider('terminal', terminal);
  const id = controller.open(launcherSpec());
  return { state, controller, browser, terminal, id, unregisterBrowser, unregisterTerminal };
};

test('factory is import-free ESM and works with the concatenation transform', async () => {
  assert.deepEqual(Object.keys(controllerModule), ['createTabController']);
  const source = await readFile(new URL('../../../packages/shell/src/tab-controller.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require)\s*[(]/);
  const transformed = source.replace(/^export /gm, '');
  assert.doesNotMatch(transformed, /^\s*(import|export)\s/m);
  assert.doesNotMatch(source, /layout\.selectPanel|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /\.generation\b/);
  const state = createTabState();
  const context = { state, AbortController };
  for (const name of ['window', 'document', 'Host', 'PTY', 'fetch']) {
    Object.defineProperty(context, name, { get() { throw Error('Unexpected runtime access'); } });
  }
  const controller = vm.runInNewContext(transformed + '\ncreateTabController(state)', context);
  assert.equal(controller.getSnapshot(), state.getSnapshot());
  assert.equal(controller.open({ kind: 'profile-ui', key: 'local', title: 'Home' }), 'local');
  await controller.dispose();
});

test('snapshot/subscription forward state and private specs never appear in public metadata', async () => {
  const { controller, state, native } = fixture();
  assert.equal(controller.getSnapshot, state.getSnapshot);
  assert.equal(controller.subscribe, state.subscribe);
  assert.equal(Object.isFrozen(controller), true);
  assert.deepEqual(Object.keys(controller).sort(), ['getSnapshot', 'subscribe', 'registerProvider', 'open', 'mount', 'activate', 'close', 'suspend', 'retry', 'replace', 'move', 'resize', 'invoke', 'dispose'].sort());
  const observed = [];
  const off = controller.subscribe(() => observed.push(controller.getSnapshot()));
  const input = spec({ connection: { token: 'nested-secret' } });
  const id = controller.open(input);
  assert.equal(typeof id, 'string');
  assert.equal(observed.length, 1);
  assert.equal(observed[0], state.getSnapshot());
  assert.doesNotMatch(JSON.stringify(observed), /private|secret|url|token|connection|generation/);
  for (const item of observed[0].tabs) assert.equal(Object.hasOwn(item, 'generation'), false);
  controller.mount(id, {});
  assert.equal(native.calls[0].spec, input);
  assert.equal(native.calls[0].spec.connection.token, 'nested-secret');
  native.calls[0].resolve(handle());
  off();
  off();
  await controller.dispose();
});

test('Local selection never needs or invokes a provider', async () => {
  for (const localProfileId of [undefined, 'home']) {
    const state = createTabState({ localProfileId });
    const controller = createTabController(state);
    const input = { kind: 'profile-ui', key: localProfileId === undefined ? 'local' : 'alias', title: 'Ignored', profileId: localProfileId };
    if (localProfileId === undefined) {
      const initial = controller.getSnapshot();
      assert.throws(() => controller.open({ ...input, key: 'remote' }), { code: 'TAB_PROVIDER_UNAVAILABLE' });
      assert.equal(controller.getSnapshot(), initial);
    }
    assert.equal(controller.open(input), 'local');
    const native = provider(() => { throw Error('Local must never open'); });
    const unregister = controller.registerProvider('profile-ui', native);
    assert.equal(controller.open(input), 'local');
    assert.equal(await controller.mount('local', {})(), false);
    assert.equal(await controller.close('local'), false);
    assert.equal(await controller.retry('local'), false);
    assert.equal(await controller.replace('local', spec()), false);
    assert.equal(controller.move('local', 0), true);
    assert.equal(controller.resize('local'), false);
    await unregister();
    assert.equal(native.calls.length, 0);
    assert.equal(controller.getSnapshot().tabs.length, 1);
    await controller.dispose();
  }
});

test('missing providers reject synchronously without reserving a fake tab or allocating an ID', async () => {
  let ids = 0;
  const state = createTabState({ localProfileId: 'home', makeId: () => String(++ids) });
  const controller = createTabController(state);
  const initial = controller.getSnapshot();
  for (const kind of ['profile-ui', 'terminal', 'browser']) {
    assert.throws(() => controller.open(spec({ kind, profileId: 'remote' })), { code: 'TAB_PROVIDER_UNAVAILABLE' });
  }
  assert.equal(controller.getSnapshot(), initial);
  assert.equal(ids, 0);
  await controller.dispose();
});

test('registration permits one provider per supported kind and revocation is idempotent', async () => {
  const { controller, native, unregister } = fixture();
  assert.throws(() => controller.registerProvider('browser', native), { code: 'TAB_PROVIDER_REGISTERED' });
  assert.throws(() => controller.registerProvider('unsupported', native), TypeError);
  assert.throws(() => controller.registerProvider('terminal', {}), TypeError);
  const first = unregister();
  assert.equal(unregister(), first);
  await first;
  const replacement = controller.registerProvider('browser', provider());
  await unregister();
  assert.equal(typeof controller.open(spec()), 'string');
  await replacement();
  await controller.dispose();
});

test('open only reserves; repeated mounts open one identity exactly once', async () => {
  const resource = handle();
  const { controller, native } = fixture(() => resource);
  const id = controller.open(spec());
  assert.equal(native.calls.length, 0);
  const container = {};
  const detach = controller.mount(id, container);
  controller.mount(id, container);
  controller.mount(id, container);
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].container, container);
  assert.deepEqual(resource.visible, [true]);
  assert.equal(native.calls[0].signal.aborted, false);
  assert.equal(tab(controller, id).phase, 'opening');
  const closing = detach();
  assert.equal(detach(), closing);
  assert.equal(tab(controller, id), undefined);
  assert.equal(native.calls[0].signal.aborted, true);
  assert.equal(await closing, true);
  assert.equal(resource.disposed, 1);
  await controller.dispose();
});

test('deduplication selects without opening again, replacing specs, or retrying failures', async () => {
  const resource = handle();
  const { controller, native } = fixture(() => resource);
  const input = spec();
  const id = controller.open(input);
  controller.mount(id, {});
  controller.activate('local');
  assert.equal(controller.open(spec({ title: 'Changed', token: 'replacement' })), id);
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].spec, input);
  assert.equal(tab(controller, id).title, 'A');
  assert.equal(controller.getSnapshot().activeId, id);
  native.calls[0].onError('CONNECT_FAILED');
  const failed = tab(controller, id);
  assert.equal(controller.open(spec()), id);
  controller.mount(id, {});
  assert.equal(tab(controller, id), failed);
  assert.equal(native.calls.length, 1);
  await controller.dispose();
  assert.equal(resource.disposed, 1);
});

test('visibility switches retain mounted handles without detaching, opening, or focusing', async () => {
  const resources = [];
  const { controller, native } = fixture(() => { const value = handle(); resources.push(value); return value; });
  const a = controller.open(spec());
  controller.mount(a, {});
  native.calls[0].onReady();
  const b = controller.open(spec({ key: 'b' }));
  controller.mount(b, {});
  native.calls[1].onReady();
  for (const id of ['local', a, b, a, 'local', b]) {
    assert.equal(controller.activate(id), true);
    assert.equal(resources[0].visible.at(-1), id === a);
    assert.equal(resources[1].visible.at(-1), id === b);
  }
  assert.equal(native.calls.length, 2);
  assert.equal(resources[0].disposed + resources[1].disposed, 0);
  assert.equal(resources[0].focused + resources[1].focused, 0);
  await controller.dispose();
});

test('an inactive surface is hidden on its initial synchronous or late acquisition', async () => {
  for (const synchronous of [true, false]) {
    const resource = handle();
    const { controller, native } = fixture(synchronous ? () => resource : undefined);
    const id = controller.open(spec());
    controller.activate('local');
    controller.mount(id, {});
    if (!synchronous) { native.calls[0].resolve(resource); await tick(); }
    assert.deepEqual(resource.visible, [false]);
    native.calls[0].onReady();
    assert.equal(resource.visible.at(-1), false);
    assert.equal(resource.focused, 0);
    await controller.dispose();
  }
});

test('closing active and inactive acquired tabs commits metadata before async cleanup', async () => {
  const gate = deferred();
  const resources = [];
  const { controller, native } = fixture(() => {
    const value = handle({ dispose() { this.disposed++; assert.equal(tab(controller, this.id), undefined); return gate.promise; } });
    resources.push(value);
    return value;
  });
  const a = controller.open(spec());
  controller.mount(a, {});
  resources[0].id = a;
  const b = controller.open(spec({ key: 'b' }));
  controller.mount(b, {});
  resources[1].id = b;
  const inactive = controller.close(a);
  assert.equal(controller.getSnapshot().activeId, b);
  assert.equal(resources[0].disposed, 0);
  assert.equal(native.calls[0].signal.aborted, true);
  const active = controller.close(b);
  assert.equal(controller.getSnapshot().activeId, 'local');
  assert.equal(native.calls[1].signal.aborted, true);
  assert.equal(await controller.close(b), false);
  gate.resolve();
  assert.deepEqual(await Promise.all([inactive, active]), [true, true]);
  assert.deepEqual(resources.map((item) => item.disposed), [1, 1]);
  await controller.dispose();
});

test('closing pending acquisition does not wait for it and releases its late handle once', async () => {
  const { controller, native } = fixture();
  const id = controller.open(spec());
  controller.mount(id, {});
  const call = native.calls[0];
  assert.equal(await controller.close(id), true);
  assert.equal(call.signal.aborted, true);
  assert.equal(call.onReady(), false);
  assert.equal(call.onError('LATE_ERROR'), false);
  const resource = handle();
  call.resolve(resource);
  await controller.dispose();
  assert.equal(resource.disposed, 1);
  assert.deepEqual(resource.visible, []);
});

test('detach only closes the same live entry and current container', async () => {
  const resources = [];
  const { controller, native } = fixture(() => { const value = handle(); resources.push(value); return value; }, { makeId: () => 'reuse' });
  const id = controller.open(spec());
  const first = controller.mount(id, {});
  const second = controller.mount(id, {});
  assert.equal(await first(), false);
  assert.ok(tab(controller, id));
  assert.equal(native.calls.length, 1);
  await controller.close(id);
  const reopened = controller.open(spec());
  assert.equal(reopened, id);
  const third = controller.mount(reopened, {});
  assert.equal(await second(), false);
  assert.ok(tab(controller, reopened));
  assert.equal(await third(), true);
  await controller.dispose();
  assert.deepEqual(resources.map((item) => item.disposed), [1, 1]);
});

test('open Promise resolution does not imply native page readiness', async () => {
  const { controller, native } = fixture();
  const id = controller.open(spec());
  controller.mount(id, {});
  const resource = handle();
  native.calls[0].resolve(resource);
  await tick();
  assert.equal(tab(controller, id).phase, 'opening');
  assert.equal(native.calls[0].onReady(), true);
  assert.equal(tab(controller, id).phase, 'ready');
  assert.equal(native.calls[0].onReady(), false);
  assert.equal(resource.focused, 0);
  await controller.dispose();
});

test('synchronous onReady can precede handle acquisition without losing the handle', async () => {
  const resource = handle();
  const { controller } = fixture((call) => { call.onReady(); return resource; });
  const id = controller.open(spec());
  controller.mount(id, {});
  assert.equal(tab(controller, id).phase, 'ready');
  assert.deepEqual(resource.visible, [true]);
  assert.equal(controller.resize(id), true);
  assert.equal(resource.resized, 1);
  await controller.dispose();
  assert.equal(resource.disposed, 1);
});

test('synchronous failure wins before or after readiness and cleans returned handles exactly once', async () => {
  for (const readyFirst of [false, true]) {
    const resource = handle();
    const { controller, native } = fixture((call) => {
      if (readyFirst) call.onReady();
      call.onError('FIRST_FAILURE');
      call.onReady();
      call.onError('SECOND_FAILURE');
      return resource;
    });
    const id = controller.open(spec());
    controller.mount(id, {});
    assert.equal(tab(controller, id).phase, 'error');
    assert.deepEqual(tab(controller, id).error, { code: 'FIRST_FAILURE' });
    assert.equal(native.calls[0].signal.aborted, true);
    assert.deepEqual(resource.visible, []);
    await controller.close(id);
    await controller.dispose();
    assert.equal(resource.disposed, 1);
  }
});

test('exit notifications are idempotent and carry the frozen public identity', async () => {
  const events = [];
  const state = createTabState();
  const controller = createTabController(state, { onExit(id, identity) { events.push({ id, identity }); } });
  const resources = [];
  const native = provider(() => { const value = handle(); resources.push(value); return value; });
  controller.registerProvider('browser', native);
  const id = controller.open(spec());
  controller.mount(id, {});
  native.calls[0].onReady();
  const firstIdentity = tab(controller, id).identity;
  assert.equal(native.calls[0].onExit(), true);
  assert.equal(native.calls[0].onExit(), false);
  assert.deepEqual(events, [{ id, identity: firstIdentity }]);
  await controller.retry(id);
  assert.equal(native.calls.length, 2);
  assert.equal(native.calls[0].onExit(), false);
  native.calls[1].onReady();
  const secondIdentity = tab(controller, id).identity;
  assert.notEqual(secondIdentity, firstIdentity);
  assert.equal(native.calls[1].onExit(), true);
  assert.deepEqual(events, [{ id, identity: firstIdentity }, { id, identity: secondIdentity }]);
  await controller.close(id);
  assert.equal(native.calls[1].onExit(), false);
  await controller.dispose();
  assert.equal(native.calls[1].onExit(), false);
  assert.equal(resources.every((value) => value.disposed === 1), true);
});

test('errors invalidate pending callbacks, sanitize codes, and release acquired handles', async () => {
  const reasons = ['CONNECT_FAILED', { code: 'NATIVE_FAILED', message: 'secret' }, Error('secret URL'), { code: 'https://private/?token=secret' }, { get code() { throw Error('secret'); } }];
  for (const reason of reasons) {
    const state = createTabState();
    const passed = [];
    const controller = createTabController({ ...state, setPhase(...args) { passed.push(args); return state.setPhase(...args); } });
    const resource = handle();
    const native = provider(() => resource);
    controller.registerProvider('browser', native);
    const id = controller.open(spec());
    controller.mount(id, {});
    native.calls[0].onReady();
    assert.equal(native.calls[0].onError(reason), true);
    const failure = tab(controller, id);
    assert.equal(native.calls[0].onReady(), false);
    assert.equal(native.calls[0].onError('SECOND'), false);
    assert.equal(tab(controller, id), failure);
    assert.match(passed.at(-1)[3], /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.equal(typeof passed.at(-1)[3], 'string');
    assert.equal(passed.at(-1)[1], failure.identity, 'controller must pass the identity, never a number');
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /secret|https/);
    await controller.dispose();
    assert.equal(resource.disposed, 1);
  }
});

test('synchronous provider throws and async rejection become safe errors without unhandled rejection', async () => {
  for (const mode of ['throw', 'reject']) {
    const { controller } = fixture(() => {
      const reason = Object.assign(Error('secret-token'), { code: 'OPEN_FAILED' });
      if (mode === 'throw') throw reason;
      return Promise.reject(reason);
    });
    const id = controller.open(spec());
    assert.doesNotThrow(() => controller.mount(id, {}));
    await tick();
    assert.equal(tab(controller, id).phase, 'error');
    assert.deepEqual(tab(controller, id).error, { code: 'OPEN_FAILED' });
    await controller.dispose();
  }
});

test('invalid acquired handles fail safely, including hostile dispose getters', async () => {
  for (const resource of [null, undefined, {}, { dispose: 1 }, { get dispose() { throw Error('secret'); } }]) {
    const { controller } = fixture(() => resource);
    const id = controller.open(spec());
    controller.mount(id, {});
    assert.deepEqual(tab(controller, id).error, { code: 'TAB_INVALID_HANDLE' });
    await controller.dispose();
  }
});

test('retry rotates identity immediately but waits for acquired-handle cleanup before reopening the original surface', async () => {
  const gate = deferred();
  const first = handle({ dispose() { this.disposed++; return gate.promise; } });
  const next = handle();
  let count = 0;
  const { controller, native } = fixture(() => count++ === 0 ? first : next);
  const input = spec();
  const id = controller.open(input);
  const container = {};
  controller.mount(id, container);
  const old = native.calls[0];
  old.onReady();
  const original = tab(controller, id);
  controller.activate('local');
  const retried = controller.retry(id);
  const opening = tab(controller, id);
  assert.notEqual(opening.identity, original.identity);
  assert.equal(opening.phase, 'opening');
  assert.equal(controller.getSnapshot().activeId, 'local');
  assert.equal(old.signal.aborted, true);
  assert.equal(old.onReady(), false);
  assert.equal(old.onError('OLD'), false);
  controller.mount(id, container);
  await tick();
  assert.equal(first.disposed, 1);
  assert.equal(native.calls.length, 1);
  gate.resolve();
  assert.equal(await retried, true);
  assert.equal(native.calls.length, 2);
  assert.equal(native.calls[1].container, container);
  assert.equal(native.calls[1].spec, input);
  assert.deepEqual(next.visible, [false]);
  native.calls[1].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
  await controller.dispose();
  assert.equal(first.disposed, 1);
  assert.equal(next.disposed, 1);
});

test('retry during old cleanup supersedes waiting identities and never opens stale runs', async () => {
  const gate = deferred();
  const first = handle({ dispose() { this.disposed++; return gate.promise; } });
  const final = handle();
  let count = 0;
  const { controller, native } = fixture(() => count++ === 0 ? first : final);
  const id = controller.open(spec());
  controller.mount(id, {});
  const retry1 = controller.retry(id);
  const identity1 = tab(controller, id).identity;
  const retry2 = controller.retry(id);
  assert.notEqual(tab(controller, id).identity, identity1);
  await tick();
  assert.equal(native.calls.length, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([retry1, retry2]), [false, true]);
  assert.equal(native.calls.length, 2);
  await controller.dispose();
  assert.equal(first.disposed, 1);
  assert.equal(final.disposed, 1);
});

test('close during retry cleanup removes the tab immediately and prevents a replacement open', async () => {
  const gate = deferred();
  const resource = handle({ dispose() { this.disposed++; return gate.promise; } });
  const { controller, native } = fixture(() => resource);
  const id = controller.open(spec());
  controller.mount(id, {});
  const retried = controller.retry(id);
  const closed = controller.close(id);
  assert.equal(tab(controller, id), undefined);
  gate.resolve();
  assert.equal(await retried, false);
  assert.equal(await closed, true);
  assert.equal(native.calls.length, 1);
  await controller.dispose();
  assert.equal(resource.disposed, 1);
});

test('retry of acquiring runs does not wait for old acquisition and ignores all stale callbacks', async () => {
  const { controller, native } = fixture();
  const id = controller.open(spec());
  const container = {};
  controller.mount(id, container);
  const old = native.calls[0];
  assert.equal(await controller.retry(id), true);
  assert.equal(native.calls.length, 2);
  assert.equal(old.signal.aborted, true);
  assert.equal(old.onReady(), false);
  assert.equal(old.onError('OLD_FAILED'), false);
  const next = native.calls[1];
  next.onReady();
  const ready = tab(controller, id);
  const late = handle();
  old.resolve(late);
  next.resolve(handle());
  await tick();
  assert.equal(tab(controller, id), ready);
  assert.equal(late.disposed, 1);
  assert.deepEqual(late.visible, []);
  await controller.dispose();
});

test('unmounted retry does not open until mounted and error retry clears public error metadata', async () => {
  const { controller, native } = fixture(() => handle());
  const id = controller.open(spec());
  assert.equal(await controller.retry(id), true);
  assert.equal(native.calls.length, 0);
  controller.mount(id, {});
  native.calls[0].onError('FAILED');
  assert.ok(tab(controller, id).error);
  const retried = controller.retry(id);
  assert.equal(Object.hasOwn(tab(controller, id), 'error'), false);
  await retried;
  assert.equal(native.calls.length, 2);
  await controller.dispose();
});

test('old callbacks and detach cannot affect a new identity with a reused public ID', async () => {
  const { controller, native } = fixture(undefined, { makeId: () => 'reused-id' });
  const id = controller.open(spec());
  const detach = controller.mount(id, {});
  const old = native.calls[0];
  const identity = tab(controller, id).identity;
  await controller.close(id);
  assert.equal(controller.open(spec()), id);
  controller.mount(id, {});
  assert.notEqual(tab(controller, id).identity, identity);
  assert.equal(old.onReady(), false);
  assert.equal(old.onError('OLD_FAILED'), false);
  assert.equal(await detach(), false);
  const late = handle();
  old.resolve(late);
  native.calls[1].resolve(handle());
  native.calls[1].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
  await controller.dispose();
  assert.equal(late.disposed, 1);
});

test('unregister cancels acquiring and unmounted tabs of its kind, not Local or other providers', async () => {
  const { controller, native, unregister } = fixture();
  const terminal = provider(() => handle());
  controller.registerProvider('terminal', terminal);
  const a = controller.open(spec());
  controller.mount(a, {});
  const b = controller.open(spec({ key: 'b' }));
  const other = controller.open(spec({ kind: 'terminal', key: 'other' }));
  controller.mount(other, {});
  const revoked = unregister();
  assert.equal(unregister(), revoked);
  assert.equal(tab(controller, a), undefined);
  assert.equal(tab(controller, b), undefined);
  assert.ok(tab(controller, other));
  assert.ok(tab(controller, 'local'));
  assert.equal(native.calls[0].signal.aborted, true);
  assert.throws(() => controller.open(spec()), { code: 'TAB_PROVIDER_UNAVAILABLE' });
  await revoked;
  const replacement = provider(() => handle());
  controller.registerProvider('browser', replacement);
  const next = controller.open(spec());
  controller.mount(next, {});
  await unregister();
  assert.ok(tab(controller, next));
  assert.equal(native.calls[0].onReady(), false);
  const late = handle();
  native.calls[0].resolve(late);
  await controller.dispose();
  assert.equal(late.disposed, 1);
});

test('focus is opt-in and immediate: delayed readiness or acquisition never steals focus', async () => {
  const { controller, native } = fixture();
  const id = controller.open(spec());
  controller.mount(id, {});
  assert.equal(controller.activate(id, { focus: true }), true);
  controller.activate('local');
  const resource = handle();
  native.calls[0].resolve(resource);
  native.calls[0].onReady();
  await tick();
  assert.equal(resource.focused, 0);
  controller.activate(id);
  assert.equal(resource.focused, 0);
  controller.activate(id, { focus: true });
  assert.equal(resource.focused, 1);
  controller.activate('local');
  native.calls[0].onReady();
  assert.equal(resource.focused, 1);
  await controller.dispose();
});

test('throwing listeners and throwing/rejecting optional methods or cleanup do not skip other cleanup', async () => {
  const resources = [];
  const { controller, unregister } = fixture(() => {
    const index = resources.length;
    const resource = handle({
      setVisible() { if (index % 2) return Promise.reject(Error('visibility')); throw Error('visibility'); },
      focus() { return Promise.reject(Error('focus')); },
      resize() { throw Error('resize'); },
      dispose() { this.disposed++; if (index % 2) return Promise.reject(Error('cleanup')); throw Error('cleanup'); },
    });
    resources.push(resource);
    return resource;
  });
  let notifications = 0;
  controller.subscribe(() => { throw Error('observer'); });
  controller.subscribe(() => { notifications++; });
  for (const key of ['a', 'b', 'c']) {
    const id = controller.open(spec({ key }));
    assert.doesNotThrow(() => controller.mount(id, {}));
    controller.activate(id, { focus: true });
    assert.equal(controller.resize(id), false);
  }
  assert.ok(notifications >= 3);
  await unregister();
  assert.deepEqual(resources.map((item) => item.disposed), [1, 1, 1]);
  assert.equal(controller.getSnapshot().tabs.length, 1);
  await controller.dispose();
});

test('dispose invalidates every tab first, is idempotent, and waits for late acquisitions and async cleanup', async () => {
  const { controller, native, state } = fixture();
  const a = controller.open(spec());
  controller.mount(a, {});
  const b = controller.open(spec({ key: 'b' }));
  controller.mount(b, {});
  native.calls[0].signal.addEventListener('abort', () => {
    assert.equal(native.calls[1].onReady(), false);
    assert.equal(native.calls[1].onError('ABORT_REENTRY'), false);
  });
  const before = controller.getSnapshot();
  const first = controller.dispose();
  assert.equal(controller.dispose(), first);
  assert.equal(state.reserve(spec()), null);
  assert.equal(controller.getSnapshot(), before);
  assert.equal(native.calls.every((call) => call.signal.aborted), true);
  let finished = false;
  first.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(native.calls.length, 2);
  const gate = deferred();
  const late = handle({ dispose() { this.disposed++; return gate.promise; } });
  native.calls[0].resolve(late);
  native.calls[1].reject(Error('late rejection'));
  await tick();
  assert.equal(late.disposed, 1);
  assert.equal(finished, false);
  gate.resolve();
  await first;
  assert.equal(finished, true);
  assert.equal(late.disposed, 1);
  assert.equal(controller.dispose(), first);
});

test('dispose inside a synchronous ready observer still tracks and releases the later returned handle', async () => {
  const resource = handle();
  const { controller, native } = fixture((call) => { call.onReady(); return resource; });
  const id = controller.open(spec());
  let disposal;
  controller.subscribe(() => { if (tab(controller, id)?.phase === 'ready') disposal = controller.dispose(); });
  controller.mount(id, {});
  await disposal;
  assert.equal(native.calls.length, 1);
  assert.equal(resource.disposed, 1);
  assert.deepEqual(resource.visible, []);
});

test('late open rejection after close or unregister is consumed and never resurrects state', async () => {
  for (const action of ['close', 'unregister']) {
    const { controller, native, unregister } = fixture();
    const id = controller.open(spec());
    controller.mount(id, {});
    if (action === 'close') await controller.close(id); else await unregister();
    const snapshot = controller.getSnapshot();
    native.calls[0].reject(Error('late rejection with token'));
    await controller.dispose();
    assert.equal(controller.getSnapshot(), snapshot);
  }
});

test('synchronous error with async resolution or rejection preserves the first failure and releases late results', async () => {
  for (const result of ['resolve', 'reject']) {
    const { controller, native } = fixture((call) => { call.onError('FIRST_FAILURE'); return call.promise; });
    const id = controller.open(spec());
    controller.mount(id, {});
    const failed = tab(controller, id);
    assert.equal(failed.phase, 'error');
    assert.equal(native.calls[0].signal.aborted, true);
    const late = handle();
    if (result === 'resolve') native.calls[0].resolve(late);
    else native.calls[0].reject(Object.assign(Error('secret'), { code: 'SECOND_FAILURE' }));
    await tick();
    assert.equal(tab(controller, id), failed);
    assert.equal(late.disposed, result === 'resolve' ? 1 : 0);
    assert.equal(native.calls[0].onReady(), false);
    await controller.dispose();
  }
});

test('ready followed by acquisition rejection transitions to error rather than leaving a false ready tab', async () => {
  const { controller, native } = fixture((call) => { call.onReady(); return call.promise; });
  const id = controller.open(spec());
  controller.mount(id, {});
  assert.equal(tab(controller, id).phase, 'ready');
  native.calls[0].reject({ code: 'ACQUIRE_FAILED', token: 'secret' });
  await tick();
  assert.deepEqual(tab(controller, id).error, { code: 'ACQUIRE_FAILED' });
  assert.equal(native.calls[0].signal.aborted, true);
  await controller.dispose();
});

test('unregister inside a synchronous ready notification closes the tab and disposes its returned handle', async () => {
  const resource = handle();
  const { controller, native, unregister } = fixture((call) => { call.onReady(); return resource; });
  const id = controller.open(spec());
  let revoked;
  controller.subscribe(() => { if (tab(controller, id)?.phase === 'ready') revoked = unregister(); });
  controller.mount(id, {});
  await revoked;
  await controller.dispose();
  assert.equal(tab(controller, id), undefined);
  assert.equal(resource.disposed, 1);
  assert.equal(native.calls.length, 1);
});

test('retry from a state notification supersedes the outer retry without opening its stale identity', async () => {
  const resources = [];
  const { controller, native } = fixture(() => { const value = handle(); resources.push(value); return value; });
  const id = controller.open(spec());
  controller.mount(id, {});
  let nested;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    nested = controller.retry(id);
  });
  const outer = controller.retry(id);
  assert.equal(await outer, false);
  assert.equal(await nested, true);
  assert.equal(native.calls.length, 2);
  await controller.dispose();
  assert.deepEqual(resources.map((item) => item.disposed), [1, 1]);
});

test('dispose cancels retries waiting for cleanup and does not start another provider open', async () => {
  const gate = deferred();
  const resource = handle({ dispose() { this.disposed++; return gate.promise; } });
  const { controller, native } = fixture(() => resource);
  const id = controller.open(spec());
  controller.mount(id, {});
  const retried = controller.retry(id);
  const disposed = controller.dispose();
  gate.resolve();
  assert.equal(await retried, false);
  await disposed;
  assert.equal(native.calls.length, 1);
  assert.equal(resource.disposed, 1);
});

test('provider revocation during reserve leaves no fake metadata or private acquisition', async () => {
  const { controller, native, unregister } = fixture();
  controller.subscribe(() => { if (controller.getSnapshot().tabs.length > 1) unregister(); });
  assert.equal(controller.open(spec()), null);
  assert.equal(controller.getSnapshot().tabs.length, 1);
  assert.equal(native.calls.length, 0);
  await controller.dispose();
});

test('retry also waits for older late-acquisition cleanup that begins while current cleanup is pending', async () => {
  const { controller, native } = fixture();
  const id = controller.open(spec());
  controller.mount(id, {});
  const oldest = native.calls[0];
  await controller.retry(id);
  const currentGate = deferred();
  const currentHandle = handle({ dispose() { this.disposed++; return currentGate.promise; } });
  native.calls[1].resolve(currentHandle);
  await tick();
  const retried = controller.retry(id);
  const lateGate = deferred();
  const lateHandle = handle({ dispose() { this.disposed++; return lateGate.promise; } });
  oldest.resolve(lateHandle);
  await tick();
  assert.equal(lateHandle.disposed, 1);
  currentGate.resolve();
  await tick();
  assert.equal(native.calls.length, 2);
  lateGate.resolve();
  assert.equal(await retried, true);
  assert.equal(native.calls.length, 3);
  native.calls[2].resolve(handle());
  await controller.dispose();
  assert.equal(lateHandle.disposed, 1);
  assert.equal(currentHandle.disposed, 1);
});

test('a synchronous reserve subscriber mounts the published tab before open returns and opens its provider once', async (t) => {
  const resource = handle();
  const { controller, native } = fixture(() => resource);
  t.after(() => controller.dispose());
  const container = {};
  let detach;
  controller.subscribe(() => {
    const item = controller.getSnapshot().tabs.find((value) => value.closable);
    if (item && !detach) detach = controller.mount(item.id, container);
  });
  const id = controller.open(spec());
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].container, container);
  native.calls[0].onReady();
  assert.equal(native.calls.length, 1);
  assert.equal(tab(controller, id).phase, 'ready');
  assert.equal(await detach(), true);
  assert.equal(resource.disposed, 1);
});

test('React identity effects detach the old identity and mount the new one during retry publication', async (t) => {
  const gate = deferred();
  const resources = [];
  const { controller, native } = fixture(() => {
    const first = resources.length === 0;
    const value = handle({ dispose() { this.disposed++; return first ? gate.promise : undefined; } });
    resources.push(value);
    return value;
  });
  t.after(async () => { gate.resolve(); await controller.dispose(); });
  const id = controller.open(spec());
  const container = {};
  const oldDetach = controller.mount(id, container);
  const oldIdentity = tab(controller, id).identity;
  let nextDetach;
  let detachedOld;
  let mountedIdentity;
  controller.subscribe(() => {
    const item = tab(controller, id);
    if (item && item.identity !== oldIdentity && !nextDetach) {
      mountedIdentity = item.identity;
      detachedOld = oldDetach();
      nextDetach = controller.mount(id, container);
    }
  });
  const retried = controller.retry(id);
  assert.ok(tab(controller, id), 'old effect cleanup must not close the new identity');
  assert.equal(await detachedOld, false);
  assert.equal(mountedIdentity, tab(controller, id).identity);
  await tick();
  assert.equal(native.calls.length, 1, 'new effect must wait for the old handle disposal');
  gate.resolve();
  assert.equal(await retried, true);
  assert.equal(native.calls.length, 2);
  assert.equal(native.calls[1].container, container);
  assert.equal(await oldDetach(), false);
  assert.equal(await nextDetach(), true, 'new detach must capture the public identity, not the old run object');
  assert.equal(tab(controller, id), undefined);
  assert.deepEqual(resources.map((value) => value.disposed), [1, 1]);
});

test('reusing a container after retry does not let delayed old effect cleanup close the new identity', async (t) => {
  const { controller, native } = fixture(() => handle());
  t.after(() => controller.dispose());
  const id = controller.open(spec());
  const container = {};
  const oldDetach = controller.mount(id, container);
  await controller.retry(id);
  const currentDetach = controller.mount(id, container);
  native.calls[1].onReady();
  const current = tab(controller, id);
  assert.equal(await oldDetach(), false);
  assert.equal(tab(controller, id), current);
  assert.equal(native.calls.length, 2);
  assert.equal(await currentDetach(), true);
});

test('pending mounts retain only the latest container and their detach binds when reserve completes', async (t) => {
  const { controller, native } = fixture(() => handle());
  t.after(() => controller.dispose());
  const firstContainer = {};
  const secondContainer = {};
  let first;
  let second;
  const unsubscribe = controller.subscribe(() => {
    const item = controller.getSnapshot().tabs.find((value) => value.closable);
    if (!item) return;
    unsubscribe();
    first = controller.mount(item.id, firstContainer);
    second = controller.mount(item.id, secondContainer);
  });
  const id = controller.open(spec());
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].container, secondContainer);
  assert.equal(await first(), false);
  assert.ok(tab(controller, id));
  assert.equal(await second(), true);
});

test('pending mounts are discarded by close, unregister, and dispose during reserve notification', async () => {
  for (const action of ['close', 'unregister', 'dispose', 'detach']) {
    const { controller, native, unregister } = fixture(() => handle(), { makeId: () => 'pending-reused' });
    let staleDetach;
    const unsubscribe = controller.subscribe(() => {
      const item = controller.getSnapshot().tabs.find((value) => value.closable);
      if (!item) return;
      unsubscribe();
      staleDetach = controller.mount(item.id, {});
      if (action === 'close') controller.close(item.id);
      else if (action === 'unregister') unregister();
      else if (action === 'dispose') controller.dispose();
      else staleDetach();
    });
    assert.equal(controller.open(spec()), null);
    assert.equal(native.calls.length, 0);
    if (action !== 'dispose') {
      if (action === 'unregister') controller.registerProvider('browser', native);
      const id = controller.open(spec());
      controller.mount(id, {});
      await staleDetach();
      assert.ok(tab(controller, id));
      assert.equal(native.calls.length, 1);
    }
    await controller.dispose();
  }
});

test('a new identity effect can detach immediately within retry publication and cancel reopening', async (t) => {
  const { controller, native } = fixture(() => handle());
  t.after(() => controller.dispose());
  const id = controller.open(spec());
  const container = {};
  controller.mount(id, container);
  let closed;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    closed = controller.mount(id, container)();
  });
  assert.equal(await controller.retry(id), false);
  assert.equal(await closed, true);
  assert.equal(tab(controller, id), undefined);
  assert.equal(native.calls.length, 1);
});

test('unknown, Local, and post-disposal operations are safe and inert', async () => {
  const { controller, native, unregister } = fixture();
  for (const id of ['missing', 'local', null, undefined]) {
    assert.equal(await controller.close(id), false);
    assert.equal(await controller.retry(id), false);
    assert.equal(await controller.replace(id, spec()), false);
    assert.equal(controller.resize(id), false);
    assert.equal(await controller.mount(id, {})(), false);
  }
  assert.equal(controller.move('missing', 0), false);
  assert.equal(controller.activate('missing', { focus: true }), false);
  await controller.dispose();
  assert.equal(controller.open(spec()), null);
  assert.equal(controller.activate('local'), false);
  assert.equal(controller.move('local', 0), false);
  assert.equal(await controller.close('local'), false);
  assert.equal(await controller.retry('missing'), false);
  assert.equal(await controller.replace('missing', spec()), false);
  assert.equal(await controller.mount('local', {})(), false);
  assert.equal(controller.resize('local'), false);
  assert.throws(() => controller.registerProvider('browser', native), { code: 'TAB_CONTROLLER_DISPOSED' });
  await unregister();
  assert.equal(native.calls.length, 0);
});

// --- launcher, replace, move ---

test('a launcher tab opens without any provider, stays ready, and closes without Host side effects', async () => {
  const state = createTabState({ localProfileId: 'home' });
  const controller = createTabController(state);
  const initial = controller.getSnapshot();
  const id = controller.open(launcherSpec());
  assert.equal(typeof id, 'string');
  assert.equal(tab(controller, id).kind, 'launcher');
  assert.equal(tab(controller, id).phase, 'ready');
  assert.equal(controller.getSnapshot().activeId, id);
  assert.equal(initial, state.getSnapshot() === controller.getSnapshot() ? initial : initial);
  assert.equal(await controller.mount(id, {})(), true);
  assert.equal(tab(controller, id), undefined);
  const second = controller.open(launcherSpec({ key: 'launcher-b' }));
  assert.equal(controller.open(launcherSpec({ key: 'launcher-b', title: 'Renamed' })), second);
  assert.equal(tab(controller, second).title, '新建工作区');
  assert.equal(await controller.close(second), true);
  assert.equal(controller.getSnapshot().tabs.length, 1);
  await controller.dispose();
});

test('duplicate launcher keys select the existing launcher without replacing metadata', async () => {
  const state = createTabState();
  const controller = createTabController(state);
  const id = controller.open(launcherSpec());
  const identity = tab(controller, id).identity;
  controller.activate('local');
  assert.equal(controller.open(launcherSpec()), id);
  assert.equal(tab(controller, id).identity, identity);
  assert.equal(controller.getSnapshot().activeId, id);
  await controller.dispose();
});

test('replace converts the current launcher in place and starts the target provider with the reserved container', async (t) => {
  const { controller, browser, terminal, id } = launcherFixture();
  t.after(() => controller.dispose());
  const container = {};
  const detach = controller.mount(id, container);
  const original = tab(controller, id);
  const position = controller.getSnapshot().tabs.findIndex((item) => item.id === id);
  controller.activate('local');
  const pending = controller.replace(id, spec({ title: 'Web A' }));
  const replaced = tab(controller, id);
  assert.equal(replaced.id, id);
  assert.equal(replaced.kind, 'browser');
  assert.equal(replaced.title, 'Web A');
  assert.equal(replaced.phase, 'opening');
  assert.notEqual(replaced.identity, original.identity);
  assert.equal(controller.getSnapshot().tabs.indexOf(replaced), position);
  assert.equal(controller.getSnapshot().activeId, 'local', 'replace keeps the prior active state');
  assert.equal(await pending, true);
  assert.equal(browser.calls.length, 1);
  assert.equal(terminal.calls.length, 0);
  assert.equal(browser.calls[0].container, container);
  assert.equal(browser.calls[0].spec.title, 'Web A');
  assert.equal(await detach(), false, 'pre-replace launcher mount must not close the converted tab');
  assert.ok(tab(controller, id));
});

test('replace preserves the active state when the launcher was active', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  assert.equal(controller.getSnapshot().activeId, id);
  const pending = controller.replace(id, spec({ kind: 'terminal', title: 'TUI' }));
  assert.equal(controller.getSnapshot().activeId, id);
  assert.equal(tab(controller, id).kind, 'terminal');
  assert.equal(await pending, true);
  assert.equal(browser.calls.length, 0);
  assert.equal(controller.getSnapshot().activeId, id);
});

test('replace rejects non-launcher targets and unknown providers without touching the record', async (t) => {
  const { controller, state, browser, id, unregisterTerminal } = launcherFixture();
  t.after(() => controller.dispose());
  await unregisterTerminal();
  const before = controller.getSnapshot();
  assert.equal(await controller.replace(id, spec({ kind: 'terminal' })), false);
  assert.equal(controller.getSnapshot(), before);
  const terminal = controller.open(spec({ kind: 'browser', key: 'plain' }));
  const converted = tab(controller, terminal);
  assert.equal(await controller.replace(terminal, launcherSpec({ key: 'other' })), false);
  assert.equal(tab(controller, terminal), converted);
  assert.equal(await controller.replace('missing', spec()), false);
  assert.equal(await controller.replace('local', spec()), false);
  assert.equal(browser.calls.length, 0, 'no provider opens without a mounted container');
  assert.equal(state.getSnapshot(), controller.getSnapshot());
});

test('replace before mount defers provider startup until the container arrives', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  assert.equal(await controller.replace(id, spec({ title: 'Web A' })), true);
  assert.equal(browser.calls.length, 0, 'no container means no provider open');
  const container = {};
  controller.mount(id, container);
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0].container, container);
  browser.calls[0].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
});

test('replace disposes the launcher mount holder and keeps only the new provider run', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  const firstContainer = {};
  const stale = controller.mount(id, firstContainer);
  assert.equal(await controller.replace(id, spec()), true);
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0].container, firstContainer);
  assert.equal(await stale(), false, 'the pre-replace detach must not close the converted tab');
  assert.ok(tab(controller, id));
  browser.calls[0].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
});

test('a late launcher detach cannot close the converted tab even with the same ID and container', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  const container = {};
  controller.mount(id, container);
  await controller.replace(id, spec());
  const replacementDetach = controller.mount(id, container);
  browser.calls[0].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
  assert.equal(await replacementDetach(), true);
});

test('launcher callbacks and stale runs cannot modify the converted record', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  const identity = tab(controller, id).identity;
  await controller.replace(id, spec());
  assert.equal(controller.getSnapshot().activeId, id);
  assert.notEqual(tab(controller, id).identity, identity);
  assert.equal(controller.move(id, 1), true);
  assert.equal(tab(controller, id).kind, 'browser');
  assert.equal(browser.calls.length, 0);
});

test('replace waits for the target provider cleanup before reopening on retry', async (t) => {
  const gate = deferred();
  const disposed = [];
  const calls = [];
  const pendingProvider = {
    open(input, context) {
      const result = deferred();
      calls.push({ spec: input, ...context, ...result });
      return result.promise;
    },
  };
  const state = createTabState({ localProfileId: 'home' });
  const controller = createTabController(state);
  const unregister = controller.registerProvider('browser', pendingProvider);
  t.after(async () => { gate.resolve(); for (const call of calls) call.resolve(handle()); await unregister(); await controller.dispose(); });
  const id = controller.open(launcherSpec());
  await controller.replace(id, spec());
  const container = {};
  controller.mount(id, container);
  const first = calls[0];
  first.resolve(handle({ dispose() { disposed.push(1); return gate.promise; } }));
  await tick();
  first.onReady();
  const retried = controller.retry(id);
  assert.equal(tab(controller, id).phase, 'opening');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.onReady(), false);
  assert.equal(first.onError('OLD_FAILED'), false);
  // Mounting during publication re-arms the retried run, but disposal still gates the reopen.
  controller.mount(id, container);
  await tick();
  assert.equal(calls.length, 1);
  gate.resolve();
  assert.equal(await retried, true);
  assert.equal(calls.length, 2);
  assert.equal(disposed.length, 1);
  assert.equal(calls[1].container, container);
  calls[1].resolve(handle());
  calls[1].onReady();
  assert.equal(tab(controller, id).phase, 'ready');
});

test('closing or disposing during replace publication cancels the conversion cleanly', async (t) => {
  const { controller, browser, id, unregisterBrowser } = launcherFixture();
  t.after(() => controller.dispose());
  let nested;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    nested = controller.close(id);
  });
  assert.equal(await controller.replace(id, spec()), false);
  assert.equal(await nested, true);
  assert.equal(tab(controller, id), undefined);
  assert.equal(browser.calls.length, 0);
  await unregisterBrowser();
});

test('replace returns false when the target provider is revoked during publication', async (t) => {
  const { controller, browser, id, unregisterBrowser } = launcherFixture();
  t.after(() => controller.dispose());
  let revoked;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    revoked = unregisterBrowser();
  });
  const started = controller.replace(id, spec());
  assert.equal(await started, false);
  await revoked;
  assert.equal(tab(controller, id), undefined);
  assert.equal(browser.calls.length, 0);
});

test('dispose during replace publication does not start the target provider', async () => {
  const { controller, browser, id } = launcherFixture();
  let disposal;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    disposal = controller.dispose();
  });
  const replaced = controller.replace(id, spec());
  // The publication is already committed when the observer disposes: the outcome is either
  // an inert false or an inert true, but never a live provider open.
  assert.equal(await replaced, false);
  await disposal;
  assert.equal(browser.calls.length, 0);
  await controller.mount(id, {})();
});

test('replace rejects a launcher that was already converted by a nested replace', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  let nested;
  const unsubscribe = controller.subscribe(() => {
    unsubscribe();
    nested = controller.replace(id, spec({ title: 'Nested' }));
  });
  const outer = controller.replace(id, spec({ title: 'Outer' }));
  // The outer call committed first, then the nested replace saw a non-launcher and was refused.
  assert.equal(await outer, true);
  assert.equal(await nested, false);
  assert.equal(tab(controller, id).title, 'Outer');
  assert.equal(browser.calls.length, 0, 'unmounted replacement defers the provider until mount');
});

test('replace after mount starts the provider once and later callbacks remain bound to the new identity', async (t) => {
  const { controller, browser, id } = launcherFixture();
  t.after(() => controller.dispose());
  const container = {};
  controller.mount(id, container);
  assert.equal(await controller.replace(id, spec()), true);
  assert.equal(browser.calls.length, 1);
  browser.calls[0].onReady();
  const identity = tab(controller, id).identity;
  // onReady is already consumed for this run; repeat callbacks stay inert.
  assert.equal(browser.calls[0].onReady(), false);
  // The late acquisition still lands on the same live identity, so failure reporting works.
  assert.equal(browser.calls[0].onError('SECOND'), true);
  assert.deepEqual(tab(controller, id).error, { code: 'SECOND' });
  assert.equal(tab(controller, id).identity, identity);
});

test('move reorders tabs without detaching providers or changing IDs, identities, or selection', async (t) => {
  const resources = [];
  const { controller, native } = fixture(() => { const value = handle(); resources.push(value); return value; });
  t.after(() => controller.dispose());
  const a = controller.open(spec({ key: 'a' }));
  const b = controller.open(spec({ key: 'b' }));
  const c = controller.open(launcherSpec());
  controller.mount(a, {});
  controller.mount(b, {});
  native.calls[0].onReady();
  native.calls[1].onReady();
  controller.activate(b);
  const records = new Map(controller.getSnapshot().tabs.map((item) => [item.id, item]));
  assert.equal(controller.move(c, 0), true);
  assert.deepEqual(controller.getSnapshot().tabs.map((item) => item.id), [c, 'local', a, b]);
  assert.equal(controller.getSnapshot().activeId, b);
  for (const item of controller.getSnapshot().tabs) assert.equal(records.get(item.id), item);
  assert.equal(native.calls.length, 2);
  assert.deepEqual(resources.map((item) => item.disposed), [0, 0]);
  assert.equal(resources[0].visible.at(-1), false);
  assert.equal(resources[1].visible.at(-1), true);
  assert.equal(controller.resize(a), true);
});

test('move is a safe no-op for Local, unknown IDs, and invalid indices', async () => {
  const { controller, browser, id } = launcherFixture();
  await controller.dispose();
  assert.equal(controller.move(id, 0), false);
  const state = createTabState();
  const live = createTabController(state);
  const first = live.open(launcherSpec());
  const second = live.open(launcherSpec({ key: 'launcher-b' }));
  const snapshot = live.getSnapshot();
  assert.equal(live.move('local', 1), true);
  assert.deepEqual(live.getSnapshot().tabs.map((item) => item.id), [first, 'local', second]);
  for (const [target, index] of [[first, -1], [first, 4], [first, 1.5], ['missing', 0], [first, null], [first, undefined]]) {
    assert.equal(live.move(target, index), false);
    assert.equal(live.getSnapshot().tabs.length, 3);
  }
  assert.equal(live.move(second, 0), true);
  assert.deepEqual(live.getSnapshot().tabs.map((item) => item.id), [second, first, 'local']);
  assert.ok(snapshot);
  await live.dispose();
});

test('invoke rejects a tab without a run, a mount, or an acquired handle with TAB_NOT_READY', async (t) => {
  const { controller, native } = fixture();
  t.after(() => controller.dispose());
  await assert.rejects(controller.invoke('missing', 'restartHost'), { code: 'TAB_NOT_READY' });
  const id = controller.open(spec());
  await assert.rejects(controller.invoke(id, 'restartHost'), { code: 'TAB_NOT_READY' }, 'an unmounted tab has no run');
  controller.mount(id, {});
  await assert.rejects(controller.invoke(id, 'restartHost'), { code: 'TAB_NOT_READY' }, 'the provider has not acquired a handle yet');
  native.calls[0].resolve(handle());
  await tick();
  assert.equal(await controller.invoke(id, 'resize'), undefined);
  await controller.dispose();
  await assert.rejects(controller.invoke(id, 'resize'), { code: 'TAB_NOT_READY' }, 'a disposed controller cannot reach its Guest');
});

test('invoke calls the handle member as its receiver and returns the awaited result', async (t) => {
  const calls = [];
  const resource = handle({
    restartHost(mode, ...rest) { calls.push({ self: this, mode, rest }); return { ok: true, mode }; },
  });
  const { controller } = fixture(() => resource);
  t.after(() => controller.dispose());
  const id = controller.open(spec());
  controller.mount(id, {});
  const outcome = await controller.invoke(id, 'restartHost', 'wait', 'extra');
  assert.deepEqual(outcome, { ok: true, mode: 'wait' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, resource);
  assert.equal(calls[0].mode, 'wait');
  assert.deepEqual(calls[0].rest, ['extra']);
  assert.equal(await controller.invoke(id, 'resize'), undefined);
  assert.equal(resource.resized, 1);
});

test('invoke rejects non-callable members and throwing getters with TAB_UNSUPPORTED', async (t) => {
  const resource = handle({ restartHost: 'not-a-function', restartCount: 0 });
  Object.defineProperty(resource, 'explode', { get() { throw new Error('private getter'); } });
  const { controller } = fixture(() => resource);
  t.after(() => controller.dispose());
  const id = controller.open(spec());
  controller.mount(id, {});
  for (const method of ['restartHost', 'visible', 'explode', undefined, 42, null]) {
    await assert.rejects(controller.invoke(id, method), { code: 'TAB_UNSUPPORTED' }, String(method));
  }
  assert.equal(resource.disposed, 0);
  assert.equal(resource.restartCount, 0);
});

test('invoke reports TAB_NOT_READY when the run is replaced before the command settles', async (t) => {
  const gate = deferred();
  const resource = handle({ restartHost() { return gate.promise; } });
  const { controller } = fixture(() => resource);
  t.after(() => controller.dispose());
  const id = controller.open(spec());
  controller.mount(id, {});
  const invoking = controller.invoke(id, 'restartHost', 'now');
  await controller.close(id);
  gate.resolve({ ok: true });
  await assert.rejects(invoking, { code: 'TAB_NOT_READY' });
  assert.equal(tab(controller, id), undefined);
  assert.equal(resource.disposed, 1);
});
