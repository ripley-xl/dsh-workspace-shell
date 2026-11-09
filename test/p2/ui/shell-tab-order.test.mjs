import assert from 'node:assert/strict';
import test from 'node:test';

import { createTabOrderMemory } from '../../../packages/shell/src/tab-order.js';

test('factory is import-free ESM and normalizes malformed options', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../../packages/shell/src/tab-order.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.match(source, /export function createTabOrderMemory/);
  for (const options of [null, 'x', 7, [], { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { maxToken: 0 }]) {
    const memory = createTabOrderMemory(options);
    assert.equal(memory.rankOf('local'), -1);
    assert.deepEqual(memory.snapshot(), []);
  }
});

test('hydrate accepts arrays and envelopes, drops invalid tokens, dedupes, and truncates', () => {
  const memory = createTabOrderMemory({ limit: 3, maxToken: 16 });
  assert.equal(memory.hydrate(['local', 'web:alpha', 'web:alpha']), true);
  assert.deepEqual(memory.snapshot(), ['local', 'web:alpha']);
  assert.equal(memory.hydrate(['local', 'web:alpha']), false, 'an equal list is not a change');
  assert.equal(memory.hydrate(['bad token', 'x'.repeat(17), 7, null, 'tui:beta']), true);
  assert.deepEqual(memory.snapshot(), ['tui:beta'], 'invalid tokens are dropped');
  assert.equal(memory.hydrate({ order: ['a', 'b', 'c', 'd'] }), true);
  assert.deepEqual(memory.snapshot(), ['a', 'b', 'c'], 'the limit truncates from the end');
  assert.equal(memory.hydrate({ order: 'nope' }), true);
  assert.deepEqual(memory.snapshot(), []);
  assert.equal(memory.hydrate('nope'), false);
  assert.equal(Object.isFrozen(memory.snapshot()), true);
});

test('sync appends new identities in display order and keeps closed slots', () => {
  const memory = createTabOrderMemory({ limit: 8 });
  assert.equal(memory.sync(['local', 'web:alpha']), true);
  assert.deepEqual(memory.snapshot(), ['local', 'web:alpha']);
  assert.equal(memory.sync(['local', 'web:alpha']), false);

  // Reordering the open identities rewrites only their slots; a closed identity
  // between them keeps its place.
  memory.hydrate(['local', 'tui:old', 'web:alpha']);
  assert.equal(memory.sync(['web:alpha', 'local']), true);
  assert.deepEqual(memory.snapshot(), ['web:alpha', 'tui:old', 'local']);

  // A new tab between two known tabs is learned at the position it was opened in.
  memory.hydrate(['a', 'b']);
  assert.equal(memory.sync(['a', 'x', 'b']), true);
  assert.deepEqual(memory.snapshot(), ['a', 'x', 'b']);

  // Duplicate and unremembered slots collapse to one identity each.
  memory.hydrate(['a', 'b']);
  assert.equal(memory.sync(['a', 'a', null, 'b', undefined]), false);
  assert.deepEqual(memory.snapshot(), ['a', 'b']);
});

test('sync evicts closed identities first when the memory is full', () => {
  const memory = createTabOrderMemory({ limit: 3 });
  memory.hydrate(['a', 'b', 'c']);
  assert.equal(memory.sync(['a', 'b', 'x']), true);
  assert.deepEqual(memory.snapshot(), ['a', 'b', 'x'], 'the closed identity leaves before any open one');
  memory.hydrate(['a', 'b', 'c']);
  assert.equal(memory.sync(['a', 'b', 'c', 'd']), true);
  assert.deepEqual(memory.snapshot(), ['b', 'c', 'd'], 'with every identity open, the leftmost leaves');
});

test('insertionIndex places a remembered identity relative to open remembered tabs', () => {
  const memory = createTabOrderMemory({ limit: 8 });
  memory.hydrate(['local', 'web:alpha', 'tui:beta']);
  assert.equal(memory.insertionIndex('unknown', ['local', 'web:alpha']), 2, 'unknown appends');
  assert.equal(memory.insertionIndex('local', ['web:alpha', 'tui:beta']), 0, 'before every higher rank');
  assert.equal(memory.insertionIndex('web:alpha', ['local']), 1, 'after the lower rank');
  assert.equal(memory.insertionIndex('web:alpha', ['local', null, 'tui:beta']), 1, 'unremembered slots are skipped');
  assert.equal(memory.insertionIndex('tui:beta', ['local', 'web:alpha']), 2, 'after all lower ranks');
  assert.equal(memory.insertionIndex('local', ['local', 'web:alpha']), 1, 'a duplicate stays adjacent');
  assert.equal(memory.insertionIndex('web:alpha', ['local', 'web:alpha', 'tui:beta']), 2, 'duplicates go after the last copy');
  assert.equal(memory.insertionIndex('bad token', ['local']), 1);
});

test('dispose clears state and ignores later writes', () => {
  const memory = createTabOrderMemory();
  memory.hydrate(['local']);
  assert.equal(memory.insertionIndex('local', []), 0);
  memory.dispose();
  assert.deepEqual(memory.snapshot(), []);
  assert.equal(memory.hydrate(['local']), false);
  assert.equal(memory.sync(['local']), false);
  assert.equal(memory.rankOf('local'), -1);
  assert.equal(memory.insertionIndex('local', []), 0);
});
