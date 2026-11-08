import assert from 'node:assert/strict';
import test from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import {
  RIGHTBAR_RECOVERY_DELAYS,
  RIGHTBAR_RECOVERY_SLOTS,
  installRightbarSlotRecovery,
} from '../../../packages/shell/src/adapter.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A deterministic scheduler: recovery must be observable without wall-clock
// sleeps, and a leaked timer must stay visible to the test.
function manualTimers() {
  let next = 1;
  const queue = new Map();
  return {
    setTimeout(callback, delay) {
      const handle = next++;
      queue.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) {
      queue.delete(handle);
    },
    run(delay = Infinity) {
      for (const [handle, item] of [...queue]) {
        if (item.delay > delay) continue;
        queue.delete(handle);
        item.callback();
      }
    },
    pending: () => queue.size,
  };
}

function fixture() {
  const core = new SlotCore();
  core.register({ name: 'root', children: { rightbar: { kind: 'single', scope: 'root' } } }, () => null);
  core.register({ name: 'rightbar', children: { 'rightbar.session': { kind: 'single', scope: 'root' } } }, () => null);
  const slots = {
    _core: core,
    entries: core.entries.bind(core),
    entriesOfSlot: core.entriesOfSlot.bind(core),
    subscribe: core.subscribe.bind(core),
  };
  return { core, slots };
}

function sidebar(toggle) {
  return {
    isExpanded: () => true,
    toggleExpanded: () => toggle(),
  };
}

test('recovery exports the watched cells and a bounded retry schedule', () => {
  assert.deepEqual(RIGHTBAR_RECOVERY_SLOTS, ['rightbar', 'rightbar.session']);
  assert.deepEqual(RIGHTBAR_RECOVERY_DELAYS, [120, 400, 1200]);
});

test('an abdicated rightbar occupant is revived on the next retry', async (t) => {
  const f = fixture();
  const timers = manualTimers();
  const recovery = installRightbarSlotRecovery(f.slots, { timers, delays: [10], quietMs: 50, maxAttempts: 3 });
  t.after(() => recovery.dispose());
  const entry = f.core.entries('rightbar')[0];

  f.core.reportEntryError('rightbar', entry, new Error('transient commit failure'), { abdicate: true });
  assert.equal(f.slots.entriesOfSlot('rightbar').length, 0);
  await settle();
  assert.equal(recovery.getSnapshot().attempts, 1, 'the first retry is scheduled');
  assert.equal(recovery.getSnapshot().error.message, 'transient commit failure');

  timers.run();
  await settle();
  assert.deepEqual(f.slots.entriesOfSlot('rightbar'), [entry], 'the abdicated entry renders again');
  assert.equal(f.core.abdicated.has(entry), false);

  await settle();
  timers.run(50);
  assert.equal(recovery.getSnapshot().attempts, 0, 'a healthy cell restores the attempt budget');
  assert.equal(timers.pending(), 0);
});

test('a permanently failing occupant stops after the budget and releases the expand control', async (t) => {
  const f = fixture();
  const timers = manualTimers();
  const calls = [];
  let crashes = 0;
  // Simulate a deterministic render failure: every successful revival crashes
  // again through the same slot supervisior.
  f.core.subscribe('rightbar', () => {
    const entry = f.core.entries('rightbar')[0];
    if (!entry || f.slots.entriesOfSlot('rightbar').length === 0 || crashes >= 3) return;
    crashes += 1;
    f.core.reportEntryError('rightbar', entry, new Error('deterministic failure'), { abdicate: true });
  });
  const recovery = installRightbarSlotRecovery(f.slots, {
    timers, delays: [1], quietMs: 10, maxAttempts: 3,
    getService: (name) => {
      calls.push(name);
      return sidebar(() => calls.push('toggle'));
    },
  });
  t.after(() => recovery.dispose());
  f.core.reportEntryError('rightbar', f.core.entries('rightbar')[0], new Error('deterministic failure'), { abdicate: true });

  for (let tick = 0; tick < 12; tick += 1) {
    await settle();
    timers.run(20);
  }

  assert.equal(crashes, 3, 'revival is attempted once per bounded retry');
  assert.deepEqual(calls, ['sidebarRight', 'toggle'], 'the expanded column is collapsed after exhaustion');
  assert.equal(recovery.getSnapshot().exhausted, true);
  assert.equal(recovery.getSnapshot().attempts, 3);
  assert.equal(f.slots.entriesOfSlot('rightbar').length, 0, 'the dead entry stays out of the cell');
});

test('the session child slot is repaired as well', async (t) => {
  const f = fixture();
  const timers = manualTimers();
  f.core.register({ name: 'rightbar.session' }, () => null);
  const recovery = installRightbarSlotRecovery(f.slots, { timers, delays: [5], quietMs: 50 });
  t.after(() => recovery.dispose());
  const entry = f.core.entries('rightbar.session')[0];

  f.core.reportEntryError('rightbar.session', entry, new Error('session view gap'), { abdicate: true });
  await settle();
  timers.run();
  await settle();
  assert.deepEqual(f.slots.entriesOfSlot('rightbar.session'), [entry]);
});

test('dispose clears pending retries and later slot mutations stay untouched', async (t) => {
  const f = fixture();
  const timers = manualTimers();
  const recovery = installRightbarSlotRecovery(f.slots, { timers, delays: [25] });
  const entry = f.core.entries('rightbar')[0];
  f.core.reportEntryError('rightbar', entry, new Error('boom'), { abdicate: true });
  await settle();
  assert.equal(timers.pending(), 1);
  recovery.dispose();
  assert.equal(timers.pending(), 0);
  assert.equal(f.core.abdicated.has(entry), true, 'dispose must not revive on its way out');
  f.core.subscribe('rightbar', () => {});
  await settle();
  assert.equal(f.core.abdicated.has(entry), true);
});

test('an older slot core without abdication state disables the installer', () => {
  const f = fixture();
  const older = { ...f.slots, _core: { records: new Map(), markDirty() {} } };
  assert.equal(installRightbarSlotRecovery(older, { timers: manualTimers() }), null);
});
