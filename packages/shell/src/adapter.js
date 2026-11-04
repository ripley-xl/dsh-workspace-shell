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
