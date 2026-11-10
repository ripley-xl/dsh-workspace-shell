import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnEndTracker } from '../../../packages/guest/src/host/turn-end.js';

const SESSION = 'a'.repeat(32);

function harness() {
  let clock = 0;
  const listeners = new Set();
  const tracker = createTurnEndTracker({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => clock,
  });
  return {
    tracker,
    listeners,
    setNow(value) { clock = value; },
    emit(session, event) { for (const listener of [...listeners]) listener(session, event); },
  };
}

const session = { header: { id: SESSION } };
const reply = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const end = (reason) => ({ type: 'turn/end', data: { reason } });

test('the last assistant text survives until the Turn ends and is read back with the reason', () => {
  const h = harness();
  h.emit(session, reply('  Done:\n\nthe build passes.  '));
  h.emit(session, { type: 'tool/call', data: { name: 'bash' } });
  assert.equal(h.tracker.read(SESSION), null, 'nothing settles before turn/end');
  h.emit(session, end({ kind: 'completed' }));
  assert.deepEqual(h.tracker.read(SESSION), { reason: 'completed', text: 'Done: the build passes.', error: '' });
  assert.equal(h.tracker.read('b'.repeat(32)), null, 'an unknown Session has no entry');
});

test('a later reply replaces the earlier one and the last text block wins', () => {
  const h = harness();
  h.emit(session, reply('first'));
  h.emit(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'second' }, { type: 'thinking', text: 'ignored' }, { type: 'text', text: 'third' }] } },
  });
  h.emit(session, end({ kind: 'completed' }));
  assert.equal(h.tracker.read(SESSION).text, 'third');
});

test('an errored Turn reports its reason and message', () => {
  const h = harness();
  h.emit(session, reply('partial answer'));
  h.emit(session, end({ kind: 'error', error: { message: 'rate limited' } }));
  assert.deepEqual(h.tracker.read(SESSION), { reason: 'error', text: 'partial answer', error: 'rate limited' });
});

test('an aborted or unknown reason is reported as other', () => {
  const h = harness();
  h.emit(session, end({ kind: 'aborted' }));
  assert.equal(h.tracker.read(SESSION).reason, 'aborted');
  h.emit(session, end({ kind: 42 }));
  assert.equal(h.tracker.read(SESSION).reason, 'other');
});

test('long reply text is collapsed and capped', () => {
  const h = harness();
  h.emit(session, reply('x'.repeat(500)));
  h.emit(session, end({ kind: 'completed' }));
  const text = h.tracker.read(SESSION).text;
  assert.equal(text.length, 200);
  assert.ok(text.endsWith('…'));
});

test('an old entry is pruned once the retention window passes', () => {
  const h = harness();
  h.setNow(1_000);
  h.emit(session, end({ kind: 'completed' }));
  assert.ok(h.tracker.read(SESSION));
  h.setNow(1_000 + 11 * 60 * 1000);
  h.emit(session, end({ kind: 'completed' }));
  assert.ok(h.tracker.read(SESSION), 'a fresh settle for another Session prunes the stale one');
  h.setNow(1_000 + 22 * 60 * 1000);
  h.emit(session, end({ kind: 'completed' }));
  assert.ok(h.tracker.read(SESSION));
});

test('dispose detaches the sink and forgets every entry', () => {
  const h = harness();
  h.emit(session, reply('text'));
  h.emit(session, end({ kind: 'completed' }));
  h.tracker.dispose();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.tracker.read(SESSION), null);
});
