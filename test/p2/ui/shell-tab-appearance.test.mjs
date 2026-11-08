import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  TAB_APPEARANCE_COLORS,
  TAB_APPEARANCE_LIMIT,
  TAB_APPEARANCE_NAME_MAX,
  createTabAppearanceMemory,
} from '../../../packages/shell/src/tab-appearance.js';

const SOURCE = new URL('../../../packages/shell/src/tab-appearance.js', import.meta.url);

test('factory stays import-free and exposes the shared palette and limits', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.match(source, /export function createTabAppearanceMemory/);
  assert.deepEqual([...TAB_APPEARANCE_COLORS], ['blue', 'green', 'amber', 'red', 'gray']);
  assert.equal(Object.isFrozen(TAB_APPEARANCE_COLORS), true);
  assert.equal(TAB_APPEARANCE_LIMIT, 64);
  assert.equal(TAB_APPEARANCE_NAME_MAX, 64);
  for (const options of [null, 'x', 7, [], { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 999 }]) {
    const memory = createTabAppearanceMemory(options);
    assert.equal(memory.get('local'), null);
    assert.deepEqual(memory.entries(), []);
    assert.equal(memory.limit, 64);
  }
  assert.equal(createTabAppearanceMemory({ limit: 3 }).limit, 3);
  assert.equal(createTabAppearanceMemory({ limit: 1000 }).limit, TAB_APPEARANCE_LIMIT);
});

test('hydrate accepts arrays and envelopes, trims names, drops invalid entries, and freezes results', () => {
  const memory = createTabAppearanceMemory();
  assert.equal(memory.hydrate([
    { id: 'local', name: '  本机  ', color: 'blue' },
    { id: 'bad token', name: 'nope' },
    { id: 'empty', name: '  ', color: '' },
    { id: 'bad-color', name: 'x', color: 'teal' },
    { id: 'dup', name: 'one' },
    { id: 'dup', name: 'two', color: 'red' },
    { id: 'extra', name: 'ok', token: 'private', url: 'http://secret' },
  ]), true);
  assert.deepEqual(memory.get('local'), { name: '本机', color: 'blue' });
  assert.equal(Object.isFrozen(memory.get('local')), true);
  assert.deepEqual(memory.get('dup'), { name: 'two', color: 'red' }, 'the later duplicate wins');
  assert.deepEqual(memory.get('extra'), { name: 'ok' }, 'unknown fields are not copied');
  assert.equal(memory.get('bad token'), null);
  assert.equal(memory.get('empty'), null);
  assert.equal(memory.get('bad-color'), null);
  assert.equal(Object.isFrozen(memory.entries()), true);
  assert.doesNotMatch(JSON.stringify(memory.entries()), /private|http/);
  assert.equal(memory.hydrate({ entries: [{ id: 'web:alpha', color: 'green' }] }), true);
  assert.deepEqual(memory.entries(), [{ id: 'web:alpha', color: 'green' }]);
  assert.equal(memory.hydrate([{ id: 'web:alpha', color: 'green' }]), false, 'an equal list is not a change');
  assert.equal(memory.hydrate('nope'), true);
  assert.deepEqual(memory.entries(), []);
  assert.equal(memory.hydrate({ entries: 'nope' }), false);
});

test('hydrate truncates at the configured limit and keeps the first valid entries', () => {
  const memory = createTabAppearanceMemory({ limit: 2 });
  memory.hydrate([
    { id: 'a', name: 'A' },
    { id: 'bad token', name: 'dropped' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);
  assert.deepEqual(memory.entries().map((entry) => entry.id), ['a', 'b']);
});

test('prepare computes a commit-ready list without mutating memory', () => {
  const memory = createTabAppearanceMemory();
  memory.hydrate([{ id: 'local', name: '本机' }, { id: 'web:alpha', color: 'green' }]);

  const add = memory.prepare('ssh:c1:web', { name: '  生产  ', color: 'red' });
  assert.equal(add.changed, true);
  assert.deepEqual(add.entries, [
    { id: 'local', name: '本机' },
    { id: 'web:alpha', color: 'green' },
    { id: 'ssh:c1:web', name: '生产', color: 'red' },
  ]);
  assert.equal(Object.isFrozen(add), true);
  assert.equal(Object.isFrozen(add.entries), true);
  assert.deepEqual(memory.get('ssh:c1:web'), null, 'prepare does not mutate');

  memory.hydrate(add.entries);
  assert.deepEqual(memory.get('ssh:c1:web'), { name: '生产', color: 'red' });

  const update = memory.prepare('web:alpha', { name: 'Alpha', color: 'green' });
  assert.deepEqual(update.entries.at(-1), { id: 'web:alpha', name: 'Alpha', color: 'green' }, 'an update moves to the newest slot');
  memory.hydrate(update.entries);

  const same = memory.prepare('web:alpha', { name: 'Alpha', color: 'green' });
  assert.deepEqual(same, { changed: false, entries: memory.entries() });

  const remove = memory.prepare('local', { name: '', color: null });
  assert.equal(remove.changed, true);
  assert.deepEqual(remove.entries.map((entry) => entry.id), ['ssh:c1:web', 'web:alpha']);
  memory.hydrate(remove.entries);
  assert.equal(memory.get('local'), null);

  const absent = memory.prepare('local', { name: '', color: null });
  assert.equal(absent.changed, false);
  const onlyColor = memory.prepare('tui:beta', { color: 'gray' });
  assert.deepEqual(onlyColor.entries.at(-1), { id: 'tui:beta', color: 'gray' });
});

test('prepare rejects invalid names, colors, and identities', () => {
  const memory = createTabAppearanceMemory();
  for (const identity of ['bad token', 'x'.repeat(161), '', null, undefined]) {
    const result = memory.prepare(identity, { name: 'x' });
    assert.equal(result.changed, false);
    assert.deepEqual(result.entries, []);
  }
  for (const value of [null, [], 'x', { name: 7 }, { name: 'x'.repeat(65) }, { name: 'a\nb' }, { name: 'a\0b' }, { color: 'teal' }, { color: 7 }]) {
    assert.throws(() => memory.prepare('local', value), TypeError, JSON.stringify(value));
  }
  assert.equal(memory.prepare('local', { name: 'x' }).changed, true);
});

test('prepare evicts the least recently edited identity at the limit', () => {
  const memory = createTabAppearanceMemory({ limit: 2 });
  memory.hydrate([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const add = memory.prepare('c', { name: 'C' });
  assert.deepEqual(add.entries.map((entry) => entry.id), ['b', 'c']);
  memory.hydrate(add.entries);
  const touch = memory.prepare('b', { name: 'B2' });
  assert.deepEqual(touch.entries.map((entry) => entry.id), ['c', 'b'], 'an updated identity becomes newest');
});

test('dispose clears state and ignores later writes', () => {
  const memory = createTabAppearanceMemory();
  memory.hydrate([{ id: 'local', name: '本机' }]);
  assert.equal(memory.prepare('local', { name: 'X' }).changed, true);
  memory.dispose();
  assert.deepEqual(memory.entries(), []);
  assert.equal(memory.get('local'), null);
  assert.equal(memory.hydrate([{ id: 'local', name: 'late' }]), false);
  assert.deepEqual(memory.prepare('local', { name: 'late' }), { changed: false, entries: [] });
});
