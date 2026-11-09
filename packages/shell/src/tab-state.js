// Metadata only: callers retain ownership of DOM nodes and external handles.
//
// Every tab lifecycle owns one frozen identity object. `identity` replaces the former
// numeric generation: tickets carry it, `isCurrent` compares object identity, and each
// retry, close/reopen, or launcher replacement allocates a fresh object. A late callback
// that still holds the previous object can therefore never address the newer record.
export function createTabState({ localProfileId, localTitle = '本地', makeId } = {}) {
  const text = (value, name, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      throw new TypeError(`${name} must be a non-empty string of at most ${limit} characters`);
    }
    return value;
  };
  const profile = (value) => value === undefined ? undefined : text(value, 'profileId', 256);
  profile(localProfileId);
  text(localTitle, 'localTitle', 256);
  if (makeId !== undefined && typeof makeId !== 'function') throw new TypeError('makeId must be a function');

  const kinds = ['profile-ui', 'terminal', 'browser', 'launcher'];
  const identityOf = () => Object.freeze({});
  const local = Object.freeze({
    id: 'local', kind: 'profile-ui', key: 'local', title: localTitle,
    ...(localProfileId === undefined ? {} : { profileId: localProfileId }),
    phase: 'ready', identity: identityOf(), closable: false,
  });
  let snapshot = Object.freeze({ activeId: local.id, tabs: Object.freeze([local]) });
  let disposed = false;
  // Internal only: numbers survive as opaque ID uniqueness material, never as tab metadata.
  let serial = 0;
  const listeners = new Set();
  const find = (id) => snapshot.tabs.find((tab) => tab.id === id);
  const nextSerial = () => {
    if (serial === Number.MAX_SAFE_INTEGER) throw new RangeError('Tab identifiers exhausted');
    return ++serial;
  };
  const ticket = (tab, created) => Object.freeze({
    id: tab.id, identity: tab.identity, created, local: tab.id === local.id,
  });
  const publish = (tabs, activeId) => {
    snapshot = Object.freeze({ activeId, tabs: Object.freeze(tabs) });
    // Copy subscriptions so additions wait for the next publication and removals take effect immediately.
    for (const subscription of [...listeners]) {
      if (disposed) break;
      if (!listeners.has(subscription)) continue;
      try { subscription.listener(); } catch { /* One subscriber must not block the others. */ }
    }
  };
  const activate = (id) => {
    if (disposed || !find(id)) return false;
    if (snapshot.activeId !== id) publish(snapshot.tabs, id);
    return true;
  };
  const isCurrent = (id, value) => {
    if (disposed) return false;
    const tab = find(id);
    return !!tab && tab.identity === value;
  };
  const failure = (error) => {
    // Never publish arbitrary Error objects, messages, URLs, tokens, or handles.
    let code;
    try { code = typeof error === 'string' ? error : error?.code; } catch {}
    return Object.freeze({ code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TAB_FAILED' });
  };
  const validate = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Tab specification must be an object');
    const { kind, key, title, profileId } = input;
    if (!kinds.includes(kind)) throw new TypeError('Unsupported tab kind');
    text(key, 'key', 1024);
    text(title, 'title', 256);
    profile(profileId);
    return { kind, key, title, profileId };
  };
  // A launcher starts no Host and has no surface to open, so it is ready immediately.
  const phaseFor = (kind) => kind === 'launcher' ? 'ready' : 'opening';
  const record = (id, values, identity) => Object.freeze({
    id, kind: values.kind, key: values.key, title: values.title,
    ...(values.profileId === undefined ? {} : { profileId: values.profileId }),
    phase: phaseFor(values.kind), identity, closable: true,
  });

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      const subscription = { listener };
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    reserve(input) {
      if (disposed) return null;
      const values = validate(input);
      const existing = values.kind === 'profile-ui' && localProfileId !== undefined && values.profileId === localProfileId
        ? local
        : snapshot.tabs.find((tab) => tab.kind === values.kind && tab.key === values.key);
      if (existing) {
        const result = ticket(existing, false);
        activate(existing.id);
        return result;
      }
      const value = nextSerial();
      const candidate = makeId === undefined ? `tab-${value}` : text(makeId(), 'id', 256);
      if (disposed) return null;
      let id = candidate;
      let suffix = 0;
      // Deterministic generators may repeat or return the permanent Local ID.
      while (find(id)) id = `${candidate}:${value}:${++suffix}`;
      const recordValue = record(id, values, identityOf());
      const result = ticket(recordValue, true);
      publish([...snapshot.tabs, recordValue], id);
      return result;
    },
    replace(id, input) {
      if (disposed) return null;
      const tab = find(id);
      if (!tab || tab.kind !== 'launcher' || !tab.closable) return null;
      const values = validate(input);
      // A hostile getter could have closed or replaced the record during validation.
      if (!isCurrent(id, tab.identity)) return null;
      const recordValue = record(id, values, identityOf());
      publish(snapshot.tabs.map((item) => item.id === id ? recordValue : item), snapshot.activeId);
      return ticket(recordValue, true);
    },
    move(id, targetIndex) {
      if (disposed) return false;
      const tabs = snapshot.tabs;
      if (!find(id) || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= tabs.length) return false;
      const from = tabs.findIndex((item) => item.id === id);
      if (from === targetIndex) return true;
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved);
      publish(next, snapshot.activeId);
      return true;
    },
    activate,
    setPhase(id, value, phase, error) {
      if (!isCurrent(id, value) || id === local.id) return false;
      const tab = find(id);
      const allowed = tab.phase === 'opening' && (phase === 'ready' || phase === 'error')
        || tab.phase === 'ready' && phase === 'error';
      if (!allowed) return false;
      const next = Object.freeze({ ...tab, phase, ...(phase === 'error' ? { error: failure(error) } : {}) });
      if (!isCurrent(id, value) || find(id) !== tab) return false;
      publish(snapshot.tabs.map((item) => item.id === id ? next : item), snapshot.activeId);
      return true;
    },
    retry(id) {
      if (disposed) return null;
      const tab = find(id);
      if (!tab || !tab.closable) return null;
      const identity = identityOf();
      const { error, ...metadata } = tab;
      const next = Object.freeze({ ...metadata, phase: phaseFor(tab.kind), identity });
      publish(snapshot.tabs.map((item) => item.id === id ? next : item), snapshot.activeId);
      return identity;
    },
    close(id) {
      if (disposed) return false;
      const tab = find(id);
      if (!tab || !tab.closable) return false;
      publish(snapshot.tabs.filter((item) => item.id !== id), snapshot.activeId === id ? local.id : snapshot.activeId);
      return true;
    },
    isCurrent,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  });
}
