import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAB_APPEARANCE_COLORS,
  TAB_APPEARANCE_LIMIT,
  TAB_APPEARANCE_NAME_MAX,
} from '../../packages/shell/src/tab-appearance.js';
import {
  createWorkspacePreferencesStore,
  validateTabAppearance,
  validateTabOrder,
} from '../../packages/shell/src/host/workspace-preferences-store.js';

function memoryStorage() {
  const tables = new Map();
  const opened = [];
  let closes = 0;
  let active = null;
  let activeName = '';
  return {
    opened,
    get closes() { return closes; },
    storage: {
      async open(spec) {
        if (active) throw new Error('domain already open');
        opened.push(spec);
        const domain = {
          async close() {
            closes += 1;
            if (active === domain) active = null;
          },
          table(name) {
            if (!tables.has(name)) tables.set(name, new Map());
            const records = tables.get(name);
            const schema = spec.tables[name].valueSchema;
            return {
              get: (key) => records.get(key),
              entries: () => records.entries(),
              async put(key, value) { records.set(key, schema.parse(value)); },
              async delete(key) { return records.delete(key); },
            };
          },
        };
        active = domain;
        activeName = spec.name;
        return domain;
      },
      get(name) { return active && name === activeName ? active : undefined; },
    },
    records(name) { return tables.get(name); },
  };
}

test('the domain declares both per-record tables with self-healing schemas', () => {
  const store = createWorkspacePreferencesStore();
  assert.equal(store.domain.name, 'workspace_shell');
  assert.equal(store.domain.version, 1);
  assert.equal(store.domain.layout, 'per-record');
  assert.deepEqual(Object.keys(store.domain.tables).sort(), ['tab_appearance', 'tab_order']);
  for (const name of ['tab_order', 'tab_appearance']) {
    const schema = store.domain.tables[name].valueSchema;
    assert.equal(typeof schema.parse, 'function');
    assert.deepEqual(schema.parse({ version: 1, any: 'value' }), { version: 1, any: 'value' });
  }
});

test('the shared appearance palette and limits are the ones the Client renders', () => {
  assert.deepEqual([...TAB_APPEARANCE_COLORS], ['blue', 'green', 'amber', 'red', 'gray']);
  assert.equal(TAB_APPEARANCE_LIMIT, 64);
  assert.equal(TAB_APPEARANCE_NAME_MAX, 64);
});

test('validateTabOrder accepts only bounded identity tokens', () => {
  assert.deepEqual(validateTabOrder({ version: 1, order: ['local', 'web:alpha'] }).order, ['local', 'web:alpha']);
  assert.deepEqual(validateTabOrder({ version: 1, order: ['web:alpha', 'web:alpha'] }).order, ['web:alpha']);
  assert.equal(Object.isFrozen(validateTabOrder({ version: 1, order: ['local'] })), true);
  for (const value of [
    null, [], 'x', { version: 2, order: [] }, { version: 1 }, { version: 1, order: 'x' },
    { version: 1, order: ['bad token'] }, { version: 1, order: ['x'.repeat(161)] },
    { version: 1, order: Array.from({ length: 65 }, (_, index) => `t${index}`) },
  ]) {
    assert.throws(() => validateTabOrder(value), TypeError, JSON.stringify(value));
  }
});

test('validateTabAppearance accepts only display fields, bounded names and the shared palette', () => {
  const valid = validateTabAppearance({
    version: 1,
    entries: [
      { id: 'ssh:c1:web', name: '  生产  ', color: 'red' },
      { id: 'web:alpha', color: 'green', url: 'http://secret' },
      { id: 'dup', name: 'one' },
      { id: 'dup', name: 'two', color: 'blue' },
      { id: 'empty' },
    ],
  });
  assert.deepEqual(valid.entries, [
    { id: 'ssh:c1:web', name: '生产', color: 'red' },
    { id: 'web:alpha', color: 'green' },
    { id: 'dup', name: 'two', color: 'blue' },
  ]);
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.entries), true);
  assert.equal(Object.isFrozen(valid.entries[0]), true);
  assert.doesNotMatch(JSON.stringify(valid), /secret|url|hostAlias|hostName|cwd/);
  for (const value of [
    null, [], 'x', { version: 2, entries: [] }, { version: 1 }, { version: 1, entries: 'x' },
    { version: 1, entries: [{ id: 'bad token' }] },
    { version: 1, entries: [{ id: 'local', name: 7 }] },
    { version: 1, entries: [{ id: 'local', name: 'x'.repeat(65) }] },
    { version: 1, entries: [{ id: 'local', name: 'a\nb' }] },
    { version: 1, entries: [{ id: 'local', color: 'teal' }] },
    { version: 1, entries: null },
    { version: 1, entries: Array.from({ length: 65 }, (_, index) => ({ id: `t${index}`, name: 'x' })) },
  ]) {
    assert.throws(() => validateTabAppearance(value), TypeError, JSON.stringify(value));
  }
});

test('the store opens lazily and round-trips order and appearance in separate tables', async () => {
  const io = memoryStorage();
  const store = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  assert.equal(io.opened.length, 0, 'no storage work before the first request');
  assert.deepEqual(await store.readOrder(), []);
  assert.equal(io.opened.length, 1);
  assert.equal(io.opened[0].name, 'workspace_shell');
  assert.equal(await store.writeOrder(['local', 'tui:beta']), true);
  assert.deepEqual(await store.readOrder(), ['local', 'tui:beta']);

  assert.deepEqual(await store.readAppearance(), { entries: [], available: true });
  assert.equal(await store.writeAppearance([{ id: 'ssh:c1:web', name: '生产', color: 'red' }]), true);
  assert.deepEqual(await store.readAppearance(), {
    entries: [{ id: 'ssh:c1:web', name: '生产', color: 'red' }],
    available: true,
  });
  assert.deepEqual(io.records('tab_order').get('default'), { version: 1, order: ['local', 'tui:beta'] });
  assert.deepEqual(io.records('tab_appearance').get('default'), {
    version: 1,
    entries: [{ id: 'ssh:c1:web', name: '生产', color: 'red' }],
  });
  await assert.rejects(store.writeOrder(['bad token']), TypeError);
  await assert.rejects(store.writeAppearance([{ id: 'local', color: 'teal' }]), TypeError);
  assert.deepEqual(await store.readOrder(), ['local', 'tui:beta']);
  assert.deepEqual((await store.readAppearance()).entries, [{ id: 'ssh:c1:web', name: '生产', color: 'red' }]);
});

test('a missing or failing storage backend degrades to empty reads, unavailable appearance, and unsaved writes', async () => {
  const missing = createWorkspacePreferencesStore();
  assert.deepEqual(await missing.readOrder(), []);
  assert.equal(await missing.writeOrder(['local']), false);
  assert.deepEqual(await missing.readAppearance(), { entries: [], available: false });
  assert.equal(await missing.writeAppearance([{ id: 'local', name: 'x' }]), false);

  let opens = 0;
  const broken = createWorkspacePreferencesStore({ getStorageDomain: () => ({ async open() { opens += 1; throw new Error('offline'); } }) });
  assert.deepEqual(await broken.readOrder(), []);
  assert.equal(await broken.writeOrder(['local']), false);
  assert.deepEqual(await broken.readAppearance(), { entries: [], available: false });
  assert.equal(await broken.writeAppearance([{ id: 'local', name: 'x' }]), false);
  assert.deepEqual(await broken.readOrder(), []);
  assert.equal(opens, 1, 'a failed open is not retried for every request');
});

test('corrupt stored records read as empty and recover independently on the next write', async () => {
  const io = memoryStorage();
  const store = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  await store.readOrder();
  io.records('tab_order').set('default', { version: 1, order: ['bad token'] });
  io.records('tab_appearance').set('default', { version: 1, entries: [{ id: 'bad token', name: 'x' }] });
  assert.deepEqual(await store.readOrder(), []);
  assert.deepEqual(await store.readAppearance(), { entries: [], available: true });
  assert.equal(await store.writeOrder(['local']), true);
  assert.equal(await store.writeAppearance([{ id: 'local', name: '本机' }]), true);
  assert.deepEqual(await store.readOrder(), ['local']);
  assert.deepEqual(await store.readAppearance(), { entries: [{ id: 'local', name: '本机' }], available: true });
});

test('dispose closes the opened domain once and releases it for a reloaded store', async () => {
  const io = memoryStorage();
  const first = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  assert.deepEqual(await first.readOrder(), []);
  assert.equal(io.opened.length, 1);
  await first.dispose();
  assert.equal(io.closes, 1, 'the single-open domain is released on unload');
  assert.deepEqual(await first.readOrder(), []);
  assert.deepEqual(await first.readAppearance(), { entries: [], available: false });
  await first.dispose();
  assert.equal(io.closes, 1, 'disposing twice closes once');

  const second = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  assert.deepEqual(await second.readOrder(), []);
  assert.equal(io.opened.length, 2, 'the replacement store can open the domain again');
  assert.equal(await second.writeAppearance([{ id: 'local', name: '本机' }]), true);
  await second.dispose();
  assert.equal(io.closes, 2);
});

test('a reloaded store reuses an already-open domain instead of degrading', async () => {
  const io = memoryStorage();
  const first = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  assert.deepEqual(await first.readOrder(), []);
  const second = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  assert.deepEqual(await second.readOrder(), []);
  assert.equal(await second.writeAppearance([{ id: 'local', name: '本机', color: 'blue' }]), true);
  assert.deepEqual(await first.readAppearance(), {
    entries: [{ id: 'local', name: '本机', color: 'blue' }], available: true,
  });
  await second.dispose();
  assert.equal(io.closes, 0, 'a shared handle is not closed by the new generation');
  assert.deepEqual(await first.readAppearance(), {
    entries: [{ id: 'local', name: '本机', color: 'blue' }], available: true,
  });
  await first.dispose();
  assert.equal(io.closes, 1);
});

test('dispose after an in-flight open still closes the domain', async () => {
  const io = memoryStorage();
  const store = createWorkspacePreferencesStore({ getStorageDomain: () => io.storage });
  const opening = store.readAppearance();
  await store.dispose();
  await opening;
  assert.equal(io.closes, 1);
  assert.deepEqual(await store.readAppearance(), { entries: [], available: false });
});

test('an appearance table read failure reports unavailable instead of overwriting unseen data', async () => {
  const store = createWorkspacePreferencesStore({ getStorageDomain: () => ({
    async open() {
      return {
        table(name) {
          if (name === 'tab_order') return { get: () => undefined, put: async () => {} };
          return { get: () => { throw new Error('offline'); }, put: async () => {} };
        },
      };
    },
  }) });
  assert.deepEqual(await store.readAppearance(), { entries: [], available: false });
});
