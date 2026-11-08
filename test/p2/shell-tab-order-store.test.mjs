import assert from 'node:assert/strict';
import test from 'node:test';

import { createTabOrderStore, validateTabOrder } from '../../packages/shell/src/host/tab-order-store.js';

function memoryStorage() {
  const tables = new Map();
  const opened = [];
  return {
    opened,
    storage: {
      async open(spec) {
        opened.push(spec);
        return {
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
      },
    },
    records(name) { return tables.get(name); },
  };
}

test('the domain declares one per-record table with a self-healing schema', () => {
  const store = createTabOrderStore();
  assert.equal(store.domain.name, 'workspace_shell');
  assert.equal(store.domain.version, 1);
  assert.equal(store.domain.layout, 'per-record');
  const schema = store.domain.tables.tab_order.valueSchema;
  assert.equal(typeof schema.parse, 'function');
  // A strict schema would reject while the storage layer opens the domain, and one
  // damaged file would disable order memory until a restart.
  assert.deepEqual(schema.parse({ version: 1, order: ['bad token'] }), { version: 1, order: ['bad token'] });
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

test('the store opens lazily and round-trips one order', async () => {
  const io = memoryStorage();
  const store = createTabOrderStore({ getStorageDomain: () => io.storage });
  assert.equal(io.opened.length, 0, 'no storage work before the first request');
  assert.deepEqual(await store.read(), []);
  assert.equal(io.opened.length, 1);
  assert.equal(io.opened[0].name, 'workspace_shell');
  assert.equal(await store.write(['local', 'tui:beta']), true);
  assert.deepEqual(await store.read(), ['local', 'tui:beta']);
  const records = io.records('tab_order');
  assert.deepEqual(records.get('default'), { version: 1, order: ['local', 'tui:beta'] });
  await assert.rejects(store.write(['bad token']), TypeError);
  assert.deepEqual(await store.read(), ['local', 'tui:beta']);
});

test('a missing or failing storage backend degrades to empty reads and unsaved writes', async () => {
  const missing = createTabOrderStore();
  assert.deepEqual(await missing.read(), []);
  assert.equal(await missing.write(['local']), false);

  let opens = 0;
  const broken = createTabOrderStore({ getStorageDomain: () => ({ async open() { opens += 1; throw new Error('offline'); } }) });
  assert.deepEqual(await broken.read(), []);
  assert.equal(await broken.write(['local']), false);
  assert.deepEqual(await broken.read(), []);
  assert.equal(opens, 1, 'a failed open is not retried for every request');
});

test('corrupt stored records read as empty and recover on the next write', async () => {
  const io = memoryStorage();
  const store = createTabOrderStore({ getStorageDomain: () => io.storage });
  await store.read();
  io.records('tab_order').set('default', { version: 1, order: ['bad token'] });
  assert.deepEqual(await store.read(), []);
  assert.equal(await store.write(['local']), true);
  assert.deepEqual(await store.read(), ['local']);
});
