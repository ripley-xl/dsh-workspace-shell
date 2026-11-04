import assert from 'node:assert/strict';
import test from 'node:test';
import { createShellPlugin, createWorkspaceSelection } from '../../../packages/shell/src/entry.js';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { frameSeats, installFrameAdapter, matchesFrameEntry } from '../../../packages/shell/src/adapter.js';

// Registry, declaration teardown, shadowing, and microtask delivery are the real
// published SlotCore. Only the component body and Store handle are inert probes.
const children = () => Object.fromEntries(Object.entries(frameSeats).map(([name, kind]) => [name, { kind, scope: 'root' }]));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, { registerRoot = true } = {}) {
  const core = new SlotCore();
  const register = core.register.bind(core);
  const registrations = [];
  core.register = (options, component) => { registrations.push(options); return register(options, component); };
  const slots = {
    _core: core,
    entries: core.entries.bind(core),
    entriesOfSlot: core.entriesOfSlot.bind(core),
    subscribe: core.subscribe.bind(core),
  };
  const controllers = [];
  const views = [];
  const makeView = (original, cell, fail) => {
    const view = (props) => cell.active ? { shell: true, props } : original(props);
    views.push({ original, cell, fail, view });
    return view;
  };
  const install = (factory = makeView, validate, service = slots) => {
    const controller = installFrameAdapter(service, factory, validate);
    controllers.push(controller);
    return controller;
  };
  const mountRoot = (label = 'original') => {
    const store = { create() { throw new Error('The adapter must not instantiate the host Store'); } };
    const component = (props) => ({ label, props });
    const unload = core.register({ name: 'root', children: children(), store, registrant: `host:${label}` }, component);
    return { entry: core.entries('root')[0], store, component, unload };
  };
  t.after(() => {
    for (const controller of controllers.reverse()) controller.dispose();
    // A failed install can otherwise retain a throwing reconcile in queued work.
    for (const record of core.records.values()) record.listeners.clear();
  });
  return { core, slots, registrations, views, install, mountRoot, ...(registerRoot ? mountRoot() : {}) };
}
function preserve(core) {
  const records = [...core.records].map(([name, record]) => ({
    name, record, entries: record.entries, members: [...record.entries],
    spec: record.spec, epoch: core.declarationEpoch(name),
    stores: record.entries.map((entry) => entry.store),
    options: record.entries.map((entry) => ({ reference: entry.options, value: { ...entry.options } })),
  }));
  const handles = [...core.handleScopes].map(([handle, value]) => [handle, value, value.count, value.scope]);
  return () => {
    assert.equal(core.records.size, records.length);
    for (const saved of records) {
      assert.equal(core.records.get(saved.name), saved.record, `${saved.name}: record identity`);
      assert.equal(core.entries(saved.name), saved.entries, `${saved.name}: cached entries identity`);
      assert.equal(core.spec(saved.name), saved.spec, `${saved.name}: declaration identity`);
      assert.equal(core.declarationEpoch(saved.name), saved.epoch, `${saved.name}: declaration epoch`);
      saved.members.forEach((entry, index) => {
        assert.equal(core.entries(saved.name)[index], entry, `${saved.name}: entry identity`);
        assert.equal(entry.store, saved.stores[index], `${saved.name}: Store handle`);
        assert.equal(entry.options, saved.options[index].reference);
        assert.deepEqual(entry.options, saved.options[index].value, `${saved.name}: priority/options`);
        assert.equal(core.isLive(entry), true);
      });
    }
    assert.equal(core.handleScopes.size, handles.length);
    for (const [handle, pin, count, scope] of handles) {
      assert.equal(core.handleScopes.get(handle), pin);
      assert.deepEqual(pin, { count, scope });
    }
  };
}

test('real SlotCore rejects duplicate root child declarations even at a winning priority', (t) => {
  const f = fixture(t);
  const check = preserve(f.core);
  assert.throws(() => f.core.register({ name: 'root', priority: -1000, children: children() }, () => null), /slot "sidebar" is already declared/);
  assert.equal(f.core.entries('root').length, 1);
  check();
});

test('frame contract requires every expected root seat, a Store factory, and writable component', (t) => {
  const f = fixture(t);
  assert.deepEqual(frameSeats, { sidebar: 'single', main: 'keyed', rightbar: 'single', 'shell.bottom': 'single', 'shell.overlay': 'list', 'shell.leading': 'single' });
  assert.equal(Object.isFrozen(frameSeats), true);
  assert.equal(matchesFrameEntry(f.entry), true);
  assert.equal(matchesFrameEntry(null), false);
  assert.equal(matchesFrameEntry({ ...f.entry, store: {} }), false);
  assert.equal(matchesFrameEntry({ ...f.entry, component: {} }), false);
  for (const name of Object.keys(frameSeats)) {
    const incomplete = children();
    delete incomplete[name];
    assert.equal(matchesFrameEntry({ ...f.entry, children: incomplete }), false, name);
    assert.equal(matchesFrameEntry({ ...f.entry, children: { ...children(), [name]: { kind: frameSeats[name], scope: 'occurrence' } } }), false, name);
  }
  assert.equal(matchesFrameEntry({ ...f.entry, children: { ...children(), main: { kind: 'single', scope: 'root' } } }), false);
  assert.equal(matchesFrameEntry(Object.freeze({ ...f.entry })), false);
});

test('enable, disable, and disposal alter only the root view, never entries, Stores, epochs, or registration count', async (t) => {
  const f = fixture(t);
  for (const [name, kind] of Object.entries(frameSeats)) {
    f.core.register({ name, ...(kind === 'keyed' ? { key: 'conversation' } : kind === 'list' ? { id: 'notice' } : {}), store: { create() {} } }, () => name);
  }
  const check = preserve(f.core);
  const registrationCount = f.registrations.length;
  const controller = f.install();
  assert.equal(controller.getSnapshot().phase, 'active');
  const firstView = f.entry.component;
  assert.notEqual(firstView, f.component);
  assert.equal(Object.isFrozen(controller.getSnapshot()), true);
  const initialSnapshot = controller.getSnapshot();
  await settle();
  assert.equal(controller.getSnapshot(), initialSnapshot);
  controller.setEnabled(true);
  assert.equal(f.entry.component, firstView, 're-enabling active adapter must not stack wrappers');
  check();
  const phases = [];
  const unsubscribe = controller.subscribe(() => phases.push(controller.getSnapshot().phase));
  controller.setEnabled(false);
  assert.equal(f.entry.component, f.component);
  assert.equal(f.views[0].cell.active, false);
  const props = { retained: true };
  assert.deepEqual(firstView(props), { label: 'original', props });
  controller.setEnabled(false);
  assert.deepEqual(phases, ['original']);
  controller.setEnabled(true);
  assert.equal(controller.getSnapshot().phase, 'active');
  check();
  const retained = f.entry.component;
  unsubscribe();
  controller.dispose();
  assert.equal(controller.getSnapshot().phase, 'disposed');
  assert.equal(f.entry.component, f.component);
  assert.deepEqual(retained(props), { label: 'original', props });
  assert.equal(f.core.records.get('root').listeners.size, 0);
  const disposedSnapshot = controller.getSnapshot();
  controller.dispose(); controller.setEnabled(true);
  assert.equal(controller.getSnapshot(), disposedSnapshot);
  await settle();
  check();
  assert.equal(f.registrations.length, registrationCount);
  assert.deepEqual(phases, ['original', 'active']);
});

test('missing or incompatible private core is unsupported and never subscribes or registers', (t) => {
  const f = fixture(t);
  for (const _core of [undefined, {}, { records: new Map() }]) {
    const controller = f.install(undefined, undefined, {
      _core, entries() { throw new Error('unsupported read'); },
      subscribe() { throw new Error('unsupported subscription'); },
    });
    assert.equal(controller.getSnapshot().phase, 'unsupported');
    controller.setEnabled(false); controller.setEnabled(true); controller.dispose();
  }
  assert.equal(f.entry.component, f.component);
  assert.equal(f.registrations.length, 1);
});

test('waiting adapter binds a later source and source unload/HMR never resurrects old children', async (t) => {
  const f = fixture(t, { registerRoot: false });
  const controller = f.install();
  assert.equal(controller.getSnapshot().phase, 'waiting');
  const first = f.mountRoot('first');
  f.core.register({ name: 'main', key: 'conversation' }, () => null);
  const child = f.core.entries('main')[0];
  await settle();
  assert.equal(controller.getSnapshot().phase, 'active');
  const oldView = first.entry.component;
  const epoch = f.core.declarationEpoch('main');
  first.unload();
  await settle();
  assert.equal(controller.getSnapshot().phase, 'waiting');
  assert.equal(f.core.isLive(child), false);
  assert.deepEqual(f.core.entries('main'), []);
  assert.equal(first.entry.component, first.component);
  assert.deepEqual(oldView({}), { label: 'first', props: {} });
  const second = f.mountRoot('second');
  await settle();
  assert.equal(controller.getSnapshot().phase, 'active');
  assert.notEqual(second.entry.component, second.component);
  assert.equal(f.core.declarationEpoch('main'), epoch + 2, 'only host unload/redeclare advances child lifetime');
  assert.deepEqual(f.core.entries('main'), [], 'adapter does not re-register stale children');
  assert.equal(f.registrations.length, 3);
});

test('same-tick source replacement releases the old wrapper and binds the new entry once', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  const oldView = f.entry.component;
  f.unload();
  const next = f.mountRoot('hmr');
  await settle();
  assert.equal(controller.getSnapshot().phase, 'active');
  assert.equal(f.views.length, 2);
  assert.equal(f.entry.component, f.component);
  assert.deepEqual(oldView({}), { label: 'original', props: {} });
  assert.notEqual(next.entry.component, next.component);
});

for (const priority of [-1000, 1000]) {
  test(`competing root priority ${priority} produces conflict without priority escalation`, async (t) => {
    const f = fixture(t);
    const controller = f.install();
    const competitor = () => 'competitor';
    const remove = f.core.register({ name: 'root', priority }, competitor);
    const check = preserve(f.core);
    await settle();
    assert.equal(controller.getSnapshot().phase, 'conflict');
    assert.equal(f.entry.component, f.component);
    check();
    controller.setEnabled(true);
    assert.equal(controller.getSnapshot().phase, 'conflict');
    assert.equal(f.registrations.length, 2);
    assert.equal(f.views.length, 1);
    remove();
    await settle();
    assert.equal(controller.getSnapshot().phase, 'active');
    assert.equal(f.registrations.length, 2);
  });
}

test('foreign wrapper survives disable/dispose through compare-and-swap and retained view pass-through', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  const retained = f.entry.component;
  const foreign = (props) => ({ foreign: retained(props) });
  f.entry.component = foreign;
  controller.setEnabled(false);
  await settle();
  assert.equal(f.entry.component, foreign);
  assert.deepEqual(foreign({}), { foreign: { label: 'original', props: {} } });
  controller.dispose();
  assert.equal(f.entry.component, foreign);
});

test('foreign replacement remains in conflict across dirty notifications, never automatically rewraps', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  const retained = f.entry.component;
  const foreign = (props) => ({ foreign: retained(props) });
  f.entry.component = foreign;
  f.core.markDirty('root', f.core.records.get('root'));
  await settle();
  assert.equal(controller.getSnapshot().phase, 'conflict');
  assert.equal(f.entry.component, foreign);
  assert.deepEqual(foreign({}), { foreign: { label: 'original', props: {} } });
  f.core.markDirty('root', f.core.records.get('root'));
  await settle();
  assert.equal(f.entry.component, foreign);
  assert.equal(f.views.length, 1);
  assert.equal(f.registrations.length, 1);
});

test('an already-abdicated host root is not revived by the adapter', (t) => {
  const f = fixture(t);
  f.core.reportEntryError('root', f.entry, new Error('host render'), { abdicate: true });
  const controller = f.install();
  assert.equal(controller.getSnapshot().phase, 'unsupported');
  assert.equal(f.entry.component, f.component);
  assert.deepEqual(f.core.entriesOfSlot('root'), []);
  assert.equal(f.views.length, 0);
});

test('explicit validation rejection leaves the original view and host declaration untouched', (t) => {
  const f = fixture(t);
  const check = preserve(f.core);
  const controller = f.install(undefined, () => false);
  assert.equal(controller.getSnapshot().phase, 'unsupported');
  assert.equal(f.entry.component, f.component);
  assert.equal(f.views.length, 0);
  check();
});

for (const stage of ['validate', 'makeView']) {
  test(`${stage} failure is contained instead of leaking an installation exception`, (t) => {
    const f = fixture(t);
    const check = preserve(f.core);
    const fail = () => { throw new Error(`${stage} failed`); };
    let controller;
    assert.doesNotThrow(() => { controller = stage === 'validate' ? f.install(undefined, fail) : f.install(fail); });
    assert.ok(['unsupported', 'fallback'].includes(controller.getSnapshot().phase));
    assert.equal(f.entry.component, f.component);
    check();
    controller.dispose();
    assert.equal(f.core.records.get('root').listeners.size, 0);
  });
}

test('render failure restores the original and remains fallback until explicit re-enable', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  const old = f.views[0];
  old.fail();
  await settle();
  assert.equal(controller.getSnapshot().phase, 'fallback');
  assert.equal(f.entry.component, f.component);
  assert.equal(old.cell.active, false);
  assert.equal(f.views.length, 1);
  controller.setEnabled(true);
  assert.equal(controller.getSnapshot().phase, 'active');
  assert.equal(f.views.length, 2);
});

test('a stale retained failure callback cannot disable a replacement binding', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  const stale = f.views[0].fail;
  controller.setEnabled(false); controller.setEnabled(true);
  const current = f.entry.component;
  stale();
  await settle();
  assert.equal(controller.getSnapshot().phase, 'active');
  assert.equal(f.entry.component, current);
});

test('a retained failure callback cannot change terminal disposed state', (t) => {
  const f = fixture(t);
  const controller = f.install();
  const fail = f.views[0].fail;
  controller.dispose();
  const snapshot = controller.getSnapshot();
  fail();
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(f.entry.component, f.component);
});

test('a failed root notification restores the original without changing the host registry', (t) => {
  const f = fixture(t);
  const check = preserve(f.core);
  const markDirty = f.core.markDirty.bind(f.core);
  let first = true;
  f.core.markDirty = (...args) => {
    if (first) { first = false; throw new Error('notification failed'); }
    return markDirty(...args);
  };
  const controller = f.install();
  assert.equal(controller.getSnapshot().phase, 'unsupported');
  assert.equal(f.entry.component, f.component);
  assert.equal(f.views[0].cell.active, false);
  check();
});

test('non-function view factory output must never replace the host component', (t) => {
  const f = fixture(t);
  const controller = f.install(() => undefined);
  assert.ok(['unsupported', 'fallback'].includes(controller.getSnapshot().phase));
  assert.equal(f.entry.component, f.component);
});

test('abdication while active retires the binding without reviving the renderer winner', async (t) => {
  const f = fixture(t);
  const controller = f.install();
  f.core.reportEntryError('root', f.entry, new Error('host render'), { abdicate: true });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'unsupported');
  assert.equal(f.entry.component, f.component);
  assert.equal(f.views[0].cell.active, false);
  assert.deepEqual(f.core.entriesOfSlot('root'), []);
});

test('disposal before a pending source notification prevents late attachment', async (t) => {
  const f = fixture(t, { registerRoot: false });
  const controller = f.install();
  const source = f.mountRoot();
  controller.dispose();
  await settle();
  assert.equal(controller.getSnapshot().phase, 'disposed');
  assert.equal(source.entry.component, source.component);
  assert.equal(f.views.length, 0);
  assert.equal(f.core.records.get('root').listeners.size, 0);
});

test('adapter HMR disposal and reinstall never stacks live view wrappers', async (t) => {
  const f = fixture(t);
  const check = preserve(f.core);
  const first = f.install();
  const retained = f.entry.component;
  first.dispose();
  const next = f.install();
  await settle();
  assert.equal(next.getSnapshot().phase, 'active');
  assert.equal(f.views[1].original, f.component);
  assert.deepEqual(retained({}), { label: 'original', props: {} });
  assert.equal(f.core.records.get('root').listeners.size, 1);
  assert.equal(f.registrations.length, 1);
  check();
});

test('disabled adapter ignores source arrivals until explicitly enabled', async (t) => {
  const f = fixture(t, { registerRoot: false });
  const controller = f.install();
  controller.setEnabled(false);
  const source = f.mountRoot();
  await settle();
  assert.equal(controller.getSnapshot().phase, 'original');
  assert.equal(source.entry.component, source.component);
  assert.equal(f.views.length, 0);
  controller.setEnabled(true);
  assert.equal(controller.getSnapshot().phase, 'active');
});

test('competing root present before installation is never shadowed by an adapter registration', (t) => {
  const f = fixture(t);
  f.core.register({ name: 'root', priority: -1 }, () => null);
  const check = preserve(f.core);
  const controller = f.install();
  assert.equal(controller.getSnapshot().phase, 'conflict');
  assert.equal(f.entry.component, f.component);
  assert.equal(f.views.length, 0);
  assert.equal(f.registrations.length, 2);
  check();
});

// Entry tests use the real factory; resource stubs model strict locale ownership.
function entryFixture(t, { search = '', factory = createShellPlugin } = {}) {
  const dictionaries = new Map();
  const localeCalls = [], events = [], instances = [], workspaces = [], adapters = [];
  const locale = {
    register(namespace, messages) {
      const entries = Object.entries(messages).map(([language, value]) => [namespace + ':' + language, value]);
      for (const [key] of entries) if (dictionaries.has(key)) throw new Error('Duplicate locale dictionary: ' + key);
      localeCalls.push(namespace);
      for (const [key, value] of entries) dictionaries.set(key, value);
      return () => {
        for (const [key, value] of entries) if (dictionaries.get(key) === value) dictionaries.delete(key);
        events.push('locale:' + namespace);
      };
    },
    bind: (namespace) => (key) => dictionaries.get(namespace + ':en')?.[key],
  };
  const fail = (ctx, stage) => { if (ctx.failAt === stage) throw new Error(stage + ' failed'); };
  const deps = {
    window: { location: { search } }, document: {}, shellCss: '',
    createWorkspaceClient({ ctx }) {
      fail(ctx, 'workspace');
      const workspace = {
        tabs: { getSnapshot: () => [], subscribe: () => () => {} },
        registerProvider() {}, open() {}, activate() {}, close() {}, retry() {}, disposed: false,
        async dispose() {
          await settle();
          workspace.disposed = true;
          events.push('workspace');
        },
      };
      workspaces.push(workspace);
      return workspace;
    },
    createFrameViews(_React, { ctx }) {
      fail(ctx, 'views');
      return { makeView: () => () => null };
    },
    installFrameAdapter(slots, makeView, validate) {
      fail(slots, 'adapter');
      assert.equal(typeof makeView, 'function');
      assert.equal(typeof validate, 'function');
      const adapter = {
        disposed: false, getSnapshot: () => ({ phase: adapter.disposed ? 'disposed' : 'active' }),
        dispose() { adapter.disposed = true; events.push('adapter'); },
      };
      adapters.push(adapter);
      return adapter;
    },
  };
  const fresh = (failAt) => {
    const effects = [], provided = new Map(), injections = [];
    const ctx = {
      locale, failAt,
      effect(setup, label) {
        const cleanup = setup();
        assert.equal(typeof cleanup, 'function');
        effects.push({ cleanup, label });
        return cleanup;
      },
      provide(name, value) { provided.set(name, value); },
    };
    ctx.slots = {
      failAt,
      inject(name, setup) { injections.push(name); return ctx.effect(setup, 'footer'); },
      register(options, component) {
        fail(ctx, 'footer');
        return () => { events.push('footer'); };
      },
    };
    const plugin = factory({}, deps);
    const instance = {
      ctx, effects, provided, injections, apply: () => plugin.apply(ctx),
      async dispose() {
        while (effects.length) await effects.pop().cleanup();
      },
    };
    instances.push(instance);
    return instance;
  };
  t.after(async () => { for (const instance of [...instances].reverse()) await instance.dispose(); });
  return { fresh, dictionaries, locale, localeCalls, events, workspaces, adapters };
}

test('real shell entry disposes locale ownership and reinstalls the workspace service after HMR', async (t) => {
  const f = entryFixture(t);
  f.locale.register('other-plugin', { en: { title: 'Other' } });
  f.locale.register('workspace-shell', { fr: { workspace: 'Espace' } });
  const external = [...f.dictionaries];
  for (let cycle = 0; cycle < 2; cycle++) {
    const instance = f.fresh();
    assert.doesNotThrow(instance.apply);
    assert.equal(f.dictionaries.size, external.length + 2);
    assert.equal(f.dictionaries.get('workspace-shell:en').workspace, 'Workspace');
    assert.ok(f.dictionaries.get('workspace-shell:zh').workspace);
    assert.equal(instance.effects[0].label, 'workspace locale dictionaries');
    assert.equal(instance.provided.has('workspaceShell'), true);
    assert.deepEqual(instance.injections, [], 'the sidebar layout entry is removed');
    assert.equal(f.adapters.length, cycle + 1);
    assert.equal(f.adapters[cycle].getSnapshot().phase, 'active');
    await instance.dispose();
    assert.equal(f.adapters[cycle].disposed, true);
    assert.equal(f.workspaces[cycle].disposed, true);
    assert.equal(instance.effects.length, 0);
    assert.deepEqual([...f.dictionaries], external);
    assert.deepEqual(f.events.slice(cycle * 3), ['adapter', 'workspace', 'locale:workspace-shell']);
  }
  assert.deepEqual(f.localeCalls, ['other-plugin', 'workspace-shell', 'workspace-shell', 'workspace-shell']);
});

for (const stage of ['workspace', 'views', 'adapter']) {
  test('real shell entry releases acquired effects after ' + stage + ' apply failure', async (t) => {
    const f = entryFixture(t);
    const failed = f.fresh(stage);
    assert.throws(failed.apply, new RegExp(stage + ' failed'));
    assert.equal(f.dictionaries.size, 2);
    await failed.dispose();
    assert.equal(f.dictionaries.size, 0);
    assert.ok(f.workspaces.every((workspace) => workspace.disposed));
    assert.ok(f.adapters.every((adapter) => adapter.disposed));
    const expected = stage === 'workspace' ? [] : ['workspace'];
    assert.deepEqual(f.events, [...expected, 'locale:workspace-shell']);
    const retry = f.fresh();
    assert.doesNotThrow(retry.apply);
    assert.equal(f.adapters.at(-1).getSnapshot().phase, 'active');
    await retry.dispose();
    assert.equal(f.dictionaries.size, 0);
  });
}

test('real shell entry skips every registration in embedded mode', async (t) => {
  const f = entryFixture(t, { search: '?workspaceShellEmbedded=1' });
  const instance = f.fresh();
  assert.doesNotThrow(instance.apply);
  await instance.dispose();
  assert.equal(f.dictionaries.size, 0);
  assert.deepEqual(f.localeCalls, []);
  assert.deepEqual(f.workspaces, []);
  assert.deepEqual(f.adapters, []);
  assert.equal(instance.provided.size, 0);
  assert.deepEqual(instance.injections, []);
  assert.deepEqual(instance.effects, []);
  assert.deepEqual(f.events, []);
});

test('real shell entry does not remove an externally registered conflicting dictionary', async (t) => {
  const f = entryFixture(t);
  f.locale.register('workspace-shell', { en: { workspace: 'External' } });
  const external = [...f.dictionaries];
  const instance = f.fresh();
  assert.throws(instance.apply, /Duplicate locale dictionary: workspace-shell:en/u);
  await instance.dispose();
  assert.deepEqual([...f.dictionaries], external);
  assert.deepEqual(instance.effects, []);
  assert.deepEqual(f.workspaces, []);
  assert.deepEqual(f.adapters, []);
});

test('in-memory untracked locale regression fails the second real entry apply before footer/adapter', async (t) => {
  const source = createShellPlugin.toString();
  const tracked = "ctx.effect(() => ctx.locale.register('workspace-shell', shellMessages), 'workspace locale dictionaries');";
  assert.ok(source.includes(tracked), 'mutation must remove the real entry locale effect');
  const oldSource = source.replace(tracked, "ctx.locale.register('workspace-shell', shellMessages);");
  const factory = Function('createWorkspaceSelection', 'return (' + oldSource + ');')(createWorkspaceSelection);
  const f = entryFixture(t, { factory });
  const first = f.fresh();
  assert.doesNotThrow(first.apply);
  assert.equal(f.adapters.length, 1);
  await first.dispose();
  assert.equal(f.dictionaries.size, 2, 'untracked dictionaries survive disposal');
  assert.equal(f.adapters[0].disposed, true);
  const second = f.fresh();
  assert.throws(second.apply, /Duplicate locale dictionary: workspace-shell:en/u);
  await second.dispose();
  assert.equal(f.adapters.length, 1);
  assert.equal(f.workspaces.length, 1);
  assert.deepEqual(second.effects, []);
  assert.deepEqual(second.injections, []);
  assert.equal(f.dictionaries.size, 2);
});
