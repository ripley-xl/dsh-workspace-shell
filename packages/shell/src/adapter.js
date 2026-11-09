// Private, version-gated view adapter. Never disposes or redeclares host Slots.
export const frameSeats = Object.freeze({ sidebar: 'single', main: 'keyed', rightbar: 'single', 'shell.bottom': 'single', 'shell.overlay': 'list', 'shell.leading': 'single' });

export function matchesFrameEntry(entry) {
  return typeof entry?.component === 'function'
    && typeof entry.store?.create === 'function'
    && Object.entries(frameSeats).every(([key, kind]) => entry.children?.[key]?.kind === kind && entry.children[key].scope === 'root')
    && Object.getOwnPropertyDescriptor(entry, 'component')?.writable === true;
}

export function installFrameAdapter(slots, makeView, validate = () => true) {
  const core = slots?._core;
  let stopped = false;
  let enabled = true;
  let binding;
  const contested = new WeakMap();
  let revision = 0;
  let snapshot = Object.freeze({ phase: 'waiting', revision });
  const listeners = new Set();
  const publish = (phase) => {
    if (snapshot.phase === phase) return;
    snapshot = Object.freeze({ ...snapshot, phase, revision: ++revision });
    for (const listener of [...listeners]) listener();
  };
  const poke = () => {
    const record = core.records.get('root');
    if (record?.spec) core.markDirty('root', record);
  };
  const release = () => {
    if (!binding) return;
    const current = binding;
    binding = undefined;
    // Retained wrappers become pass-through even when another plugin wrapped us.
    current.cell.active = false;
    if (current.entry.component === current.view) current.entry.component = current.original;
    if (core.isLive(current.entry)) poke();
  };
  const fail = () => {
    enabled = false;
    release();
    publish('fallback');
  };
  const compatibleCore = typeof core?.records?.get === 'function'
    && typeof core?.markDirty === 'function' && typeof core?.isLive === 'function'
    && typeof slots?.subscribe === 'function' && typeof slots?.entries === 'function';
  const reconcile = () => {
    if (stopped || !enabled || !compatibleCore) return;
    const entries = slots.entries('root');
    if (entries.length !== 1) {
      release();
      publish(entries.length ? 'conflict' : 'waiting');
      return;
    }
    const entry = entries[0];
    if (slots.entriesOfSlot && slots.entriesOfSlot('root')[0] !== entry) { release(); publish('unsupported'); return; }
    if (binding?.entry === entry) {
      if (entry.component === binding.view) return;
      contested.set(entry, binding.original);
      release();
      publish('conflict');
      return;
    }
    release();
    if (contested.has(entry)) {
      if (entry.component !== contested.get(entry)) { publish('conflict'); return; }
      contested.delete(entry);
    }
    try {
      if (!matchesFrameEntry(entry) || !validate(entry)) { publish('unsupported'); return; }
    } catch { publish('unsupported'); return; }
    // An abdicated root must stay abdicated; do not bypass renderer error policy.
    if (slots.entriesOfSlot && slots.entriesOfSlot('root')[0] !== entry) { publish('unsupported'); return; }
    const original = entry.component;
    const cell = { active: true };
    let view;
    try { view = makeView(original, cell, () => { if (!stopped && cell.active && binding?.cell === cell) fail(); }); } catch { cell.active = false; publish('unsupported'); return; }
    if (typeof view !== 'function') { cell.active = false; publish('unsupported'); return; }
    binding = { entry, original, view, cell };
    try {
      entry.component = view;
      poke();
      publish('active');
    } catch {
      release();
      publish('unsupported');
    }
  };
  const unsubscribe = compatibleCore ? slots.subscribe('root', reconcile) : () => {};
  try { if (compatibleCore) reconcile(); else publish('unsupported'); } catch {
    unsubscribe();
    if (binding) { const current = binding; binding = undefined; current.cell.active = false; if (current.entry.component === current.view) current.entry.component = current.original; }
    stopped = true; publish('unsupported');
  }
  return {
    reportFrame(frame) {
      if (stopped) return;
      snapshot = Object.freeze({ ...snapshot, frame: frame ? Object.freeze(frame) : null, revision: ++revision });
      for (const listener of [...listeners]) listener();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) {
      if (stopped) return;
      enabled = Boolean(value);
      if (enabled) reconcile(); else { release(); publish('original'); }
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      release();
      publish('disposed');
      listeners.clear();
    },
  };
}

// The right column's occupant is a DSH Slot entry. The slot core catches one
// render crash and "abdicates" that entry: it is removed from the cell for the
// rest of the page. The right Sidebar's own store still says `expanded`, so the
// conversation header's expand control (rendered only while collapsed) is gone
// and the panel cannot be reached again. A crashed entry can be revived by
// removing it from the core's abdication set and marking the cell dirty: a
// fresh error boundary then renders it again from the current state, which
// covers transient commit-phase failures (session view churn). The attempt
// budget is bounded so a deterministic crash cannot loop; after exhaustion the
// column is collapsed so the header control comes back.
export const RIGHTBAR_RECOVERY_SLOTS = Object.freeze(['rightbar', 'rightbar.session']);
export const RIGHTBAR_RECOVERY_DELAYS = Object.freeze([120, 400, 1200]);
const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
});

export function installRightbarSlotRecovery(slots, options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const core = slots?._core;
  const timers = input.timers ?? DEFAULT_TIMERS;
  const delays = Array.isArray(input.delays) && input.delays.length ? input.delays : RIGHTBAR_RECOVERY_DELAYS;
  const maxAttempts = Number.isInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : 3;
  const quietMs = Number.isFinite(input.quietMs) && input.quietMs >= 0 ? input.quietMs : 2000;
  const onFailure = typeof input.onFailure === 'function' ? input.onFailure : null;
  const getService = typeof input.getService === 'function' ? input.getService : () => undefined;
  const supported = typeof slots?.subscribe === 'function' && typeof slots.entries === 'function'
    && typeof slots.entriesOfSlot === 'function' && core instanceof Object
    && typeof core.records?.get === 'function' && typeof core.markDirty === 'function'
    && core.abdicated instanceof WeakSet;
  if (!supported) return null;

  let stopped = false;
  let attempts = 0;
  let retryTimer = null;
  let quietTimer = null;
  let lastError = null;
  let exhausted = false;

  const raw = (key) => {
    try { return Array.isArray(slots.entries(key)) ? slots.entries(key) : []; } catch { return []; }
  };
  const active = (key) => {
    try { return Array.isArray(slots.entriesOfSlot(key)) ? slots.entriesOfSlot(key) : []; } catch { return []; }
  };
  // A cell is broken when it still has registrations but none of them render,
  // and the core remembers abdicating at least one of them.
  function broken() {
    for (const key of RIGHTBAR_RECOVERY_SLOTS) {
      const entries = raw(key);
      if (!entries.length || active(key).length) continue;
      const dead = entries.filter((entry) => core.abdicated.has(entry));
      if (dead.length) return { key, entries: dead };
    }
    return null;
  }
  function clearQuiet() {
    if (quietTimer === null) return;
    timers.clearTimeout(quietTimer);
    quietTimer = null;
  }
  function scheduleQuiet() {
    if (stopped || quietTimer !== null) return;
    quietTimer = timers.setTimeout(() => {
      quietTimer = null;
      if (stopped) return;
      // Only a column that stayed healthy earns a fresh attempt budget.
      if (broken() === null) {
        attempts = 0;
        exhausted = false;
      }
    }, quietMs);
  }
  function revive(target) {
    const record = core.records?.get?.(target.key);
    let changed = false;
    for (const entry of target.entries) {
      if (core.abdicated.delete(entry)) changed = true;
    }
    if (changed && record !== undefined) core.markDirty(target.key, record);
    return changed;
  }
  // Collapse the expanded right column so the header's expand control (which
  // renders only on a collapsed layout) becomes reachable again.
  function releaseControl() {
    let sidebarRight;
    try { sidebarRight = getService('sidebarRight'); } catch { sidebarRight = null; }
    if (!sidebarRight || typeof sidebarRight.isExpanded !== 'function' || typeof sidebarRight.toggleExpanded !== 'function') return false;
    try {
      if (sidebarRight.isExpanded() !== true) return false;
      sidebarRight.toggleExpanded();
      return true;
    } catch {
      return false;
    }
  }
  function fail() {
    if (exhausted) return;
    exhausted = true;
    releaseControl();
    try { onFailure?.(lastError); } catch { /* A diagnostic hook never breaks recovery. */ }
    // A later, unrelated crash may deserve its own attempts.
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      attempts = 0;
      exhausted = false;
    }, 30000);
  }
  function examine() {
    if (stopped) return;
    if (retryTimer !== null) return;
    const target = broken();
    if (target === null) {
      scheduleQuiet();
      return;
    }
    clearQuiet();
    if (attempts >= maxAttempts) {
      fail();
      return;
    }
    const delay = delays[Math.min(attempts, delays.length - 1)];
    attempts += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      const next = broken();
      if (next === null) {
        scheduleQuiet();
        return;
      }
      // markDirty notifies this installer on its next microtask flush; a crash
      // during the retry lands here as a fresh, already-abdicated cell.
      revive(next);
    }, delay);
  }
  const unsubscribers = [];
  for (const key of RIGHTBAR_RECOVERY_SLOTS) {
    try {
      const off = slots.subscribe(key, examine);
      if (typeof off === 'function') unsubscribers.push(off);
    } catch { /* A slot without a live record still needs the other watcher. */ }
  }
  const unsubscribe = () => { for (const off of unsubscribers.splice(0)) off(); };
  const offEntryError = typeof core.onEntryError === 'function'
    ? core.onEntryError((key, _entry, error) => {
      if (!RIGHTBAR_RECOVERY_SLOTS.includes(key)) return;
      lastError = Object.freeze({ code: key, message: safeMessage(error) });
    })
    : () => {};
  // Repair an already-broken column when this installer attaches (plugin reload
  // and frame re-attachment happen after a crash as well).
  examine();
  return Object.freeze({
    getSnapshot: () => Object.freeze({ attempts, maxAttempts, exhausted, error: lastError }),
    reviveNow: () => {
      const target = broken();
      return target === null ? false : revive(target);
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      try { unsubscribe?.(); } catch { /* Subscription teardown is best effort. */ }
      try { offEntryError?.(); } catch { /* Listener teardown is best effort. */ }
      clearQuiet();
      if (retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  });
}

function safeMessage(error) {
  try {
    const message = typeof error === 'string' ? error : error?.message;
    return typeof message === 'string' && message.length <= 240 ? message : 'Right Sidebar slot crashed';
  } catch {
    return 'Right Sidebar slot crashed';
  }
}
