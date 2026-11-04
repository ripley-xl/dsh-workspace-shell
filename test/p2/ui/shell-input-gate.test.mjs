import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as inputGateModule from '../../../packages/shell/src/input-gate.js';

const { installInputGate } = inputGateModule;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (sequence, overrides = {}) => ({ revision: `revision-${sequence}`, sequence, document: { schemaVersion: 1, profiles: {} }, status: 'ready', error: null, usingDefaults: true, ...overrides });
const command = (id) => ({ id, defaults: { 'desktop:macos': { code: 'KeyA', modifiers: ['meta'] } } });

function fixture() {
  let current = snapshot(1);
  let sequence = 1;
  const requests = [];
  const configured = [];
  const observers = new Set();
  const subscribers = new Set();
  const fixedListeners = new Set();
  const fixedEvents = [];
  const effects = { dispatch: 0, invoke: 0, consume: 0, edit: 0, recording: 0, active: 0, maximum: 0 };
  const config = { getSnapshot: () => current };
  class Registry {
    config = config;
    commands = new Map([['local.action', command('local.action')]]);
    fixedCommands = new Map([['local.fixed', { id: 'local.fixed', bindings: [{ code: 'Escape', modifiers: [] }] }]]);
    definitions() {
      return [...this.commands.values()].map(({ id, defaults }) => ({ id, defaults })).concat([...this.fixedCommands.values()].map(({ id, bindings }) => ({ id, defaults: {}, fixed: bindings })));
    }
    refreshLabels() { this.rows = this.definitions(); }
    configure(value) {
      if (value.revision === current.revision && value.status === current.status && value.error === current.error) return;
      current = value;
      configured.push(value);
      this.refreshLabels();
      for (const observer of observers) observer(value);
    }
    register(value) {
      this.commands.set(value.id, value);
      this.refreshLabels();
      return () => { this.commands.delete(value.id); this.refreshLabels(); };
    }
    dispatch(_gesture, _context, consume = () => {}) {
      assert.equal(this, registry);
      effects.dispatch += 1;
      consume();
      return { status: 'handled' };
    }
    invoke() { assert.equal(this, registry); effects.invoke += 1; }
  }
  const registry = new Registry();
  registry.refreshLabels();
  const adapter = {
    get(definitions) {
      assert.equal(this, adapter);
      effects.active += 1;
      effects.maximum = Math.max(effects.maximum, effects.active);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ definitions: structuredClone(definitions), resolve, reject, settled: false });
      return promise.then((value) => { effects.active -= 1; return value; }, (error) => { effects.active -= 1; throw error; });
    },
    edit: async () => { effects.edit += 1; },
    recording: async () => { effects.recording += 1; },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
  class Service {
    runtime = 'desktop';
    active = true;
    connected = true;
    config = config;
    registry = registry;
    adapter = adapter;
    fixedInput(input) {
      fixedEvents.push(input.type);
      for (const listener of fixedListeners) { try { listener(input); } catch {} }
    }
    syncDefinitions() {
      if (!this.active) return;
      this.adapter.get(this.registry.definitions()).then((value) => {
        this.connected = true;
        if (this.active && value.sequence >= this.config.getSnapshot().sequence) this.registry.configure(value);
      }, () => this.failRead());
    }
    failRead() {
      if (this.active) this.registry.configure({ ...this.config.getSnapshot(), status: 'unreadable', error: 'read' });
    }
    register(value) {
      const off = this.registry.register(value);
      this.syncDefinitions();
      return () => { off(); this.syncDefinitions(); };
    }
  }
  const service = new Service();
  adapter.subscribe((value) => { if (service.active && service.connected && value.sequence >= config.getSnapshot().sequence) registry.configure(value); });
  const original = { definitions: registry.definitions, dispatch: registry.dispatch, invoke: registry.invoke, configure: registry.configure, fixedInput: service.fixedInput, adapter, connected: service.connected };
  const f = { service, registry, adapter, config, requests, configured, observers, fixedListeners, fixedEvents, effects, original, gate: undefined };
  f.install = () => (f.gate = installInputGate(service));
  f.ack = (index = requests.findIndex((row) => !row.settled), value, publish = true) => {
    const request = requests[index];
    assert.ok(request && !request.settled, `Unsettled native request ${index}`);
    request.settled = true;
    const accepted = value ?? snapshot(++sequence);
    if (publish) for (const subscriber of subscribers) subscriber(accepted);
    request.resolve(accepted);
  };
  f.reject = (index = requests.findIndex((row) => !row.settled), error = new Error('Native unavailable')) => {
    const request = requests[index];
    assert.ok(request && !request.settled);
    request.settled = true;
    request.reject(error);
  };
  f.dispatch = () => registry.dispatch({}, {}, () => { effects.consume += 1; });
  f.drain = async () => {
    for (let i = 0; i < 30; i += 1) {
      await flush();
      const index = requests.findIndex((row) => !row.settled);
      if (index < 0) return;
      f.ack(index);
    }
    throw new Error('Native queue did not drain');
  };
  f.close = async () => { const done = f.gate.dispose(); await f.drain(); await done; };
  return f;
}

test('input gate exports only its pure factory and supports the concatenation builder', async () => {
  assert.deepEqual(Object.keys(inputGateModule), ['installInputGate']);
  const source = await readFile(new URL('../../../packages/shell/src/input-gate.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require)\s*[(]/);
  const body = source.replace(/^export /gm, '');
  assert.doesNotMatch(body, /^\s*(import|export)\s/m);
  const api = vm.runInNewContext(`${body}\ninstallInputGate(undefined)`);
  assert.equal(api.supported, false);
  assert.equal(await api.setLocal(false), false);
  await api.dispose();
});

test('initial Local remains enabled and installation never writes preferences or projects a catalog', async () => {
  const f = fixture();
  const commands = f.registry.commands;
  const initial = f.registry.definitions();
  const gate = f.install();
  assert.deepEqual(Object.keys(gate).sort(), ['dispose', 'setLocal', 'supported']);
  assert.equal(Object.isFrozen(gate), true);
  assert.equal(gate.supported, true);
  assert.deepEqual(f.dispatch(), { status: 'handled' });
  f.registry.invoke('local.action', {});
  f.service.fixedInput({ type: 'keydown' });
  assert.deepEqual(f.registry.definitions(), initial);
  assert.equal(f.registry.commands, commands);
  assert.equal(f.effects.invoke, 1);
  assert.deepEqual(f.fixedEvents, ['keydown']);
  assert.equal(f.requests.length, 0);
  await f.close();
  assert.equal(f.effects.edit, 0);
  assert.equal(f.effects.recording, 0);
});

test('Local execution closes synchronously before native empty-catalog acknowledgement', async () => {
  const f = fixture();
  f.install();
  let settled = false;
  const changed = f.gate.setLocal(false).then((value) => { settled = true; return value; });
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  f.registry.invoke('local.action', {});
  f.service.fixedInput({ type: 'keydown' });
  assert.equal(f.effects.dispatch, 0);
  assert.equal(f.effects.invoke, 0);
  assert.equal(f.effects.consume, 0);
  assert.deepEqual(f.fixedEvents, ['reset']);
  assert.deepEqual(f.registry.definitions(), []);
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(f.requests[0].definitions, []);
  f.ack(0);
  assert.equal(await changed, true);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await f.close();
});

test('restoring Local waits for the full native catalog and applies the accepted snapshot', async () => {
  const f = fixture();
  f.install();
  const off = f.gate.setLocal(false);
  await f.drain();
  assert.equal(await off, true);
  f.service.connected = false;
  const on = f.gate.setLocal(true);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await flush();
  assert.equal(f.requests[1].definitions.length, 2);
  const accepted = snapshot(20);
  f.ack(1, accepted, false);
  assert.equal(await on, true);
  assert.equal(f.service.connected, true);
  assert.equal(f.config.getSnapshot(), accepted);
  assert.equal(f.registry.rows.length, 2);
  assert.deepEqual(f.dispatch(), { status: 'handled' });
  await f.close();
});

test('an older Local acknowledgement cannot reopen execution after a newer remote request', async () => {
  const f = fixture();
  f.install();
  const old = f.gate.setLocal(true);
  await flush();
  const latest = f.gate.setLocal(false);
  f.ack(0);
  assert.equal(await old, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await flush();
  assert.deepEqual(f.requests[1].definitions, []);
  f.ack(1);
  assert.equal(await latest, true);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  assert.equal(f.effects.maximum, 1);
  await f.close();
});

test('rapid remote-local-remote requests use the latest projection and only the latest request succeeds', async () => {
  const f = fixture();
  f.install();
  const a = f.gate.setLocal(false);
  const b = f.gate.setLocal(true);
  const c = f.gate.setLocal(false);
  await f.drain();
  assert.deepEqual(await Promise.all([a, b, c]), [false, false, true]);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every((request) => request.definitions.length === 0));
  assert.equal(f.effects.maximum, 1);
  await f.close();
});

test('all adapter directory calls serialize and stale supplied full catalogs cannot revive remote shortcuts', async () => {
  const f = fixture();
  f.install();
  const stale = f.original.definitions.call(f.registry);
  const first = f.service.adapter.get(stale);
  const second = f.service.adapter.get(stale);
  const remote = f.gate.setLocal(false);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].definitions, []);
  await f.drain();
  await Promise.all([first, second]);
  assert.equal(await remote, true);
  assert.ok(f.requests.every((request) => request.definitions.length === 0));
  assert.equal(f.effects.maximum, 1);
  await f.close();
});

test('register and unregister while remote preserve command ownership and never restore a full native catalog', async () => {
  const f = fixture();
  f.install();
  const remote = f.gate.setLocal(false);
  const remove = f.service.register(command('local.later'));
  remove();
  f.service.register(command('local.current'));
  await f.drain();
  assert.equal(await remote, true);
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every((request) => request.definitions.length === 0));
  assert.equal(f.registry.commands.has('local.later'), false);
  assert.equal(f.registry.commands.has('local.current'), true);
  const local = f.gate.setLocal(true);
  await f.drain();
  assert.equal(await local, true);
  assert.deepEqual(f.requests.at(-1).definitions.map((row) => row.id), ['local.action', 'local.current', 'local.fixed']);
  await f.close();
});

test('queued Local projections read command changes at execution time rather than request time', async () => {
  const f = fixture();
  f.install();
  const first = f.gate.setLocal(true);
  await flush();
  const second = f.gate.setLocal(true);
  f.registry.commands.set('local.latest', command('local.latest'));
  f.ack(0);
  assert.equal(await first, false);
  await flush();
  assert.ok(f.requests[1].definitions.some((row) => row.id === 'local.latest'));
  f.ack(1);
  assert.equal(await second, true);
  await f.close();
});

test('fixed input reset passes while remote but keydown and menu invocation remain blocked', async () => {
  const f = fixture();
  f.install();
  const changed = f.gate.setLocal(false);
  f.service.fixedInput({ type: 'reset' });
  f.service.fixedInput({ type: 'keydown' });
  f.registry.invoke('local.action', {});
  assert.deepEqual(f.fixedEvents, ['reset', 'reset']);
  assert.equal(f.effects.invoke, 0);
  await f.drain();
  await changed;
  const local = f.gate.setLocal(true);
  await f.drain();
  await local;
  f.registry.invoke('local.action', {});
  f.service.fixedInput({ type: 'keydown' });
  assert.equal(f.effects.invoke, 1);
  assert.equal(f.fixedEvents.at(-1), 'keydown');
  await f.close();
});

test('a configuration observer can switch tabs reentrantly without enabling an obsolete Local request', async () => {
  const f = fixture();
  f.install();
  let remote;
  const observer = () => { f.observers.delete(observer); remote = f.gate.setLocal(false); };
  f.observers.add(observer);
  const local = f.gate.setLocal(true);
  await flush();
  f.ack(0);
  assert.equal(await local, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await f.drain();
  assert.equal(await remote, true);
  await f.close();
});

test('dispose invalidates in-flight requests and waits before restoring original descriptors and current catalog', async () => {
  const f = fixture();
  f.install();
  const remote = f.gate.setLocal(false);
  await flush();
  f.registry.commands.set('local.added', command('local.added'));
  f.registry.commands.delete('local.action');
  const done = f.gate.dispose();
  assert.equal(f.gate.dispose(), done);
  assert.notEqual(f.service.adapter, f.adapter);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  f.ack(0);
  assert.equal(await remote, false);
  await flush();
  assert.deepEqual(f.requests[1].definitions.map((row) => row.id), ['local.added', 'local.fixed']);
  f.ack(1);
  await done;
  for (const key of ['definitions', 'dispatch', 'invoke', 'configure']) {
    assert.equal(f.registry[key], f.original[key]);
    assert.equal(Object.hasOwn(f.registry, key), false);
  }
  assert.equal(f.service.fixedInput, f.original.fixedInput);
  assert.equal(f.service.adapter, f.adapter);
  assert.equal(await f.gate.setLocal(true), false);
  assert.deepEqual(f.dispatch(), { status: 'handled' });
});

test('dispose drains registration requests added reentrantly by snapshot observers', async () => {
  const f = fixture();
  f.install();
  const remote = f.gate.setLocal(false);
  await f.drain();
  await remote;
  const observer = () => { f.observers.delete(observer); f.service.register(command('local.during-dispose')); };
  f.observers.add(observer);
  const done = f.gate.dispose();
  await f.drain();
  await done;
  assert.ok(f.requests.at(-1).definitions.some((row) => row.id === 'local.during-dispose'));
  assert.equal(f.effects.maximum, 1);
  assert.equal(f.service.adapter, f.adapter);
});

test('CAS restoration retains later third-party method wrappers and captured gate wrappers become transparent', async () => {
  const f = fixture();
  f.install();
  const oldDispatch = f.registry.dispatch;
  const oldDefinitions = f.registry.definitions;
  let calls = 0;
  const thirdDispatch = function (...args) { calls += 1; return oldDispatch.apply(this, args); };
  const thirdDefinitions = function (...args) { return oldDefinitions.apply(this, args); };
  f.registry.dispatch = thirdDispatch;
  f.registry.definitions = thirdDefinitions;
  const remote = f.gate.setLocal(false);
  await f.drain();
  await remote;
  await f.close();
  assert.equal(f.registry.dispatch, thirdDispatch);
  assert.equal(f.registry.definitions, thirdDefinitions);
  assert.equal(f.registry.definitions().length, 2);
  assert.deepEqual(f.dispatch(), { status: 'handled' });
  assert.equal(calls, 1);
});

test('CAS restoration preserves a later adapter object and a changed facade get method', async () => {
  for (const replaceObject of [false, true]) {
    const f = fixture();
    f.install();
    const facade = f.service.adapter;
    const oldGet = facade.get;
    const third = Object.create(facade);
    const laterGet = (...args) => oldGet(...args);
    if (replaceObject) { third.get = laterGet; f.service.adapter = third; }
    else facade.get = laterGet;
    await f.close();
    assert.equal(f.service.adapter, replaceObject ? third : facade);
    assert.equal(f.service.adapter.get, laterGet);
    const explicit = [command('third.party')];
    const read = f.service.adapter.get(explicit);
    assert.deepEqual(f.requests.at(-1).definitions, explicit);
    f.ack();
    await read;
  }
});

test('a frozen native bridge remains untouched because only the writable service adapter slot is replaced', async () => {
  const f = fixture();
  Object.freeze(f.adapter);
  f.install();
  assert.equal(f.gate.supported, true);
  const remote = f.gate.setLocal(false);
  await f.drain();
  assert.equal(await remote, true);
  assert.equal(Object.isFrozen(f.adapter), true);
  await f.close();
  assert.equal(f.service.adapter, f.adapter);
});

test('unsupported service shapes return inert APIs without invoking native code', async () => {
  for (const value of [undefined, null, 3, {}, { runtime: 'desktop' }]) {
    const gate = installInputGate(value);
    assert.equal(gate.supported, false);
    assert.equal(await gate.setLocal(false), false);
    await gate.dispose();
  }
  for (const mutate of [
    (f) => { f.service.active = false; },
    (f) => { f.service.runtime = 'unknown'; },
    (f) => { f.service.connected = undefined; },
    (f) => { f.registry.config = {}; },
    (f) => { f.config.getSnapshot = () => ({ sequence: NaN }); },
    (f) => { f.adapter.get = null; },
    (f) => { f.registry.definitions = () => null; },
    (f) => { f.registry.configure = undefined; },
  ]) {
    const f = fixture();
    mutate(f);
    const before = [f.registry.definitions, f.registry.dispatch, f.registry.invoke, f.registry.configure, f.service.fixedInput, f.service.adapter];
    const gate = f.install();
    assert.equal(gate.supported, false);
    assert.deepEqual([f.registry.definitions, f.registry.dispatch, f.registry.invoke, f.registry.configure, f.service.fixedInput, f.service.adapter], before);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.fixedEvents, []);
  }
});

test('nonwritable private fields are rejected before any method is hijacked', () => {
  for (const [owner, key] of [['registry', 'definitions'], ['registry', 'dispatch'], ['registry', 'invoke'], ['registry', 'configure'], ['service', 'fixedInput'], ['service', 'adapter'], ['service', 'connected']]) {
    const f = fixture();
    Object.defineProperty(f[owner], key, { value: f[owner][key], writable: false, configurable: false });
    const before = [Object.getOwnPropertyDescriptors(f.registry), Object.getOwnPropertyDescriptors(f.service)];
    assert.equal(f.install().supported, false, key);
    assert.deepEqual([Object.getOwnPropertyDescriptors(f.registry), Object.getOwnPropertyDescriptors(f.service)], before);
  }
});

test('accessors and nonextensible prototype-method owners are rejected without partial changes', () => {
  const a = fixture();
  Object.defineProperty(a.service, 'adapter', { get: () => a.adapter, configurable: true });
  assert.equal(a.install().supported, false);
  assert.equal(a.registry.dispatch, a.original.dispatch);
  const b = fixture();
  Object.preventExtensions(b.registry);
  assert.equal(b.install().supported, false);
  assert.equal(b.service.adapter, b.adapter);
  assert.equal(b.service.fixedInput, b.original.fixedInput);
});

test('a failed installation rolls back every earlier replacement', () => {
  const f = fixture();
  const proxied = new Proxy(f.service, { defineProperty(target, key, descriptor) {
    if (key === 'adapter') return false;
    return Reflect.defineProperty(target, key, descriptor);
  } });
  const before = [Object.getOwnPropertyDescriptors(f.registry), Object.getOwnPropertyDescriptors(f.service)];
  assert.equal(installInputGate(proxied).supported, false);
  assert.deepEqual([Object.getOwnPropertyDescriptors(f.registry), Object.getOwnPropertyDescriptors(f.service)], before);
  assert.equal(f.requests.length, 0);
});

test('native rejection returns false, leaves Local closed, and does not poison subsequent requests', async () => {
  const f = fixture();
  f.install();
  const first = f.gate.setLocal(false);
  await flush();
  f.reject(0);
  assert.equal(await first, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  assert.equal(f.config.getSnapshot().status, 'unreadable');
  const retry = f.gate.setLocal(true);
  await f.drain();
  assert.equal(await retry, true);
  assert.equal(f.config.getSnapshot().status, 'ready');
  assert.deepEqual(f.dispatch(), { status: 'handled' });
  await f.close();
});

test('malformed native acknowledgements fail closed without enabling Local', async () => {
  const f = fixture();
  f.install();
  const local = f.gate.setLocal(true);
  await flush();
  f.ack(0, { sequence: 3 }, false);
  assert.equal(await local, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await f.close();
});

test('older native snapshots do not overwrite a newer accepted configuration', async () => {
  const f = fixture();
  f.install();
  const remote = f.gate.setLocal(false);
  await flush();
  const newer = snapshot(90);
  f.registry.configure(newer);
  f.ack(0, snapshot(2), false);
  assert.equal(await remote, true);
  assert.equal(f.config.getSnapshot(), newer);
  await f.close();
});

test('throwing configuration observers cannot create unhandled rejections in the original void syncDefinitions', async () => {
  const f = fixture();
  f.install();
  f.observers.add(() => { throw new Error('Observer failed'); });
  assert.equal(f.service.syncDefinitions(), undefined);
  await flush();
  assert.doesNotThrow(() => f.ack(0));
  await flush();
  f.service.syncDefinitions();
  await flush();
  f.reject(1);
  await flush();
  f.observers.clear();
  await f.close();
});

test('ignored native adapter rejections are handled without inventing a successful acknowledgement', async () => {
  const f = fixture();
  f.install();
  f.service.adapter.get([]);
  await flush();
  f.reject(0);
  await flush();
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await f.close();
});

test('dispose reports native restoration failure, still restores owned methods, and is idempotent', async () => {
  const f = fixture();
  f.install();
  const done = f.gate.dispose();
  await flush();
  f.reject(0);
  await assert.rejects(done, /Native unavailable/);
  assert.equal(f.gate.dispose(), done);
  assert.equal(f.service.adapter, f.adapter);
  assert.equal(f.registry.dispatch, f.original.dispatch);
  assert.equal(await f.gate.setLocal(false), false);
});

test('an unloaded service cannot accept a late native acknowledgement or reopen execution', async () => {
  const f = fixture();
  f.install();
  const local = f.gate.setLocal(true);
  await flush();
  f.service.active = false;
  f.ack(0, snapshot(2), false);
  assert.equal(await local, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  assert.equal(await f.gate.setLocal(false), false);
  const done = f.gate.dispose();
  await flush();
  assert.equal(f.requests.length, 1, 'Do not re-register a native catalog after service unload');
  await assert.rejects(done, /acknowledgement unavailable/);
  assert.equal(f.service.adapter, f.adapter);
});

test('invalid setLocal arguments cannot authorize a tab transition', async () => {
  const f = fixture();
  f.install();
  for (const value of [undefined, null, 'false', 0, {}]) assert.equal(await f.gate.setLocal(value), false);
  assert.equal(f.requests.length, 0);
  await f.close();
});

test('dispose is already idempotent when a fixed-reset callback reenters it synchronously', async () => {
  const f = fixture();
  f.install();
  let nested;
  const listener = () => { f.fixedListeners.delete(listener); nested = f.gate.dispose(); };
  f.fixedListeners.add(listener);
  const outer = f.gate.dispose();
  await f.drain();
  await outer;
  await nested;
  assert.equal(outer, nested);
  assert.equal(f.requests.length, 1);
});

test('a synchronous fixed reset callback cannot make an older setLocal request current again', async () => {
  const f = fixture();
  f.install();
  let nested;
  const listener = () => { f.fixedListeners.delete(listener); nested = f.gate.setLocal(false); };
  f.fixedListeners.add(listener);
  const outer = f.gate.setLocal(true);
  await f.drain();
  assert.equal(await outer, false);
  assert.equal(await nested, true);
  assert.ok(f.requests.every((request) => request.definitions.length === 0));
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  await f.close();
});

test('configuration failure before commit does not count as a successful native acknowledgement', async () => {
  const f = fixture();
  const configure = f.registry.configure;
  let broken = true;
  f.registry.configure = function (value) { if (broken) throw new Error('Configuration failed'); return configure.call(this, value); };
  f.install();
  const local = f.gate.setLocal(true);
  await flush();
  f.ack(0, snapshot(2), false);
  assert.equal(await local, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  broken = false;
  await f.close();
});

test('an ignored rejected disposal has an internal rejection handler and still restores owned methods', async () => {
  const f = fixture();
  f.install();
  f.gate.dispose();
  await flush();
  f.reject(0);
  await flush();
  assert.equal(f.service.adapter, f.adapter);
  assert.equal(f.registry.dispatch, f.original.dispatch);
});

test('owned writable descriptors are restored exactly even when they are nonconfigurable', async () => {
  const f = fixture();
  Object.defineProperty(f.registry, 'dispatch', { value: f.registry.dispatch, writable: true, configurable: false, enumerable: true });
  Object.defineProperty(f.service, 'fixedInput', { value: f.service.fixedInput, writable: true, configurable: true, enumerable: true });
  const beforeDispatch = Object.getOwnPropertyDescriptor(f.registry, 'dispatch');
  const beforeFixed = Object.getOwnPropertyDescriptor(f.service, 'fixedInput');
  assert.equal(f.install().supported, true);
  await f.close();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.registry, 'dispatch'), beforeDispatch);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.service, 'fixedInput'), beforeFixed);
});

test('a falsy native rejection is still a disposal failure rather than a successful restoration', async () => {
  const f = fixture();
  f.install();
  const done = f.gate.dispose();
  await flush();
  f.reject(0, null);
  await assert.rejects(done, /Shortcut native request failed/);
  assert.equal(f.service.adapter, f.adapter);
});

test('a failing fixed reset prevents transition approval even after the native acknowledgement', async () => {
  const f = fixture();
  const fixed = f.service.fixedInput;
  let broken = true;
  f.service.fixedInput = function (input) { if (broken) throw new Error('Fixed reset failed'); return fixed.call(this, input); };
  f.install();
  const changed = f.gate.setLocal(false);
  await f.drain();
  assert.equal(await changed, false);
  assert.deepEqual(f.dispatch(), { status: 'pass' });
  broken = false;
  await f.close();
});

test('real Cordis 4.0.5 service views support gating, native queueing, receiver tracing, and descriptor CAS restoration', async (t) => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
  const metadata = JSON.parse(await readFile(sdkRequire.resolve('@deepseek-ai/cordis/package.json'), 'utf8'));
  const { Context, Service } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/cordis')).href);
  assert.equal(metadata.version, '4.0.5');
  t.diagnostic(`Real Cordis ${metadata.version}; registry and native adapter remain test doubles`);
  const f = fixture();
  const contexts = [];
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const provider = root.extend({ caller: 'shortcuts-provider' });
  const consumer = root.extend({ caller: 'input-gate-consumer' });
  class ShortcutsShape extends Service {
    constructor(ctx) { super(ctx, 'shortcuts'); Object.assign(this, f.service); }
    fixedInput(input) { contexts.push(this.ctx.caller); return f.original.fixedInput.call(this, input); }
  }
  for (const key of ['syncDefinitions', 'failRead', 'register']) {
    Object.defineProperty(ShortcutsShape.prototype, key, Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.service), key));
  }
  const raw = new ShortcutsShape(provider);
  const view = consumer.get('shortcuts');
  assert.notEqual(view, raw);
  assert.equal(view.ctx, consumer);
  assert.notEqual(view.fixedInput, view.fixedInput, 'Every read creates a new shadow-method Proxy');
  const original = Object.getOwnPropertyDescriptors(raw);
  const registryDescriptors = Object.getOwnPropertyDescriptors(f.registry);
  f.gate = installInputGate(view);
  assert.equal(f.gate.supported, true, 'Install through the actual traceable service view, not the raw instance');
  view.fixedInput({ type: 'keydown' });
  assert.equal(contexts.at(-1), 'input-gate-consumer');
  raw.fixedInput({ type: 'keydown' });
  assert.equal(contexts.at(-1), 'shortcuts-provider', 'Raw/Core calls preserve their original receiver');
  assert.deepEqual(f.fixedEvents, ['keydown', 'keydown']);
  const remote = f.gate.setLocal(false);
  view.fixedInput({ type: 'keydown' });
  raw.fixedInput({ type: 'keydown' });
  view.fixedInput({ type: 'reset' });
  assert.deepEqual(f.fixedEvents, ['keydown', 'keydown', 'reset', 'reset']);
  assert.deepEqual(view.registry.dispatch({}, {}, () => { throw new Error('Must not consume'); }), { status: 'pass' });
  view.registry.invoke('local.action', {});
  assert.equal(f.effects.invoke, 0);
  await f.drain();
  assert.equal(await remote, true);
  assert.deepEqual(f.requests[0].definitions, []);
  const unregister = view.register(command('local.via-traced-service'));
  unregister();
  await f.drain();
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every((request) => request.definitions.length === 0));
  assert.equal(raw.connected, true);
  assert.equal(f.effects.maximum, 1);
  const local = f.gate.setLocal(true);
  assert.deepEqual(view.registry.dispatch({}, {}), { status: 'pass' });
  await f.drain();
  assert.equal(await local, true);
  assert.equal(f.requests.at(-1).definitions.length, 2);
  view.fixedInput({ type: 'keydown' });
  assert.equal(f.fixedEvents.at(-1), 'keydown');
  assert.equal(contexts.at(-1), 'input-gate-consumer');
  view.registry.invoke('local.action', {});
  assert.equal(f.effects.invoke, 1);
  assert.deepEqual(view.registry.dispatch({}, {}), { status: 'handled' });
  await f.close();
  assert.deepEqual(Object.getOwnPropertyDescriptors(raw), original);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.registry), registryDescriptors);
  assert.equal(view.adapter, f.adapter);
  f.gate = installInputGate(view);
  assert.equal(f.gate.supported, true);
  const wrapped = Object.getOwnPropertyDescriptor(view, 'fixedInput').value;
  const thirdParty = function (...args) { return wrapped.apply(this, args); };
  view.fixedInput = thirdParty;
  await f.close();
  assert.equal(Object.getOwnPropertyDescriptor(view, 'fixedInput').value, thirdParty, 'CAS preserves later replacements through the real view');
  view.fixedInput({ type: 'keydown' });
  assert.equal(contexts.at(-1), 'input-gate-consumer');
  assert.equal(f.fixedEvents.at(-1), 'keydown');
  assert.equal(Reflect.deleteProperty(view, 'fixedInput'), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(raw), original);
});
