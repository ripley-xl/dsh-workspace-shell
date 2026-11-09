// The state factory is injected; provider specs and resource handles stay private.
//
// Each run is bound to the public record's frozen identity object. A run is current only
// while that same object is still installed, so retries, close/reopen, and in-place
// launcher replacement invalidate every earlier open, mount, or exit callback.
export function createTabController(state, lifecycle = {}) {
  const kinds = ['profile-ui', 'terminal', 'browser', 'launcher'];
  const providers = new Map();
  const entries = new Map();
  const pendingMounts = new Map();
  const closing = new Set();
  const pending = new Set();
  let disposed = false;
  let disposal;
  const noop = () => {};
  const find = (id) => state.getSnapshot().tabs.find((tab) => tab.id === id);
  const error = (code) => Object.assign(new Error(code), { code });
  const safeCode = (value) => {
    let code;
    try { code = typeof value === 'string' ? value : value?.code; } catch {}
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TAB_FAILED';
  };
  const track = (promise) => {
    const settled = Promise.resolve(promise).catch(noop);
    pending.add(settled);
    settled.then(() => pending.delete(settled));
    return settled;
  };
  const call = (handle, method, ...args) => {
    try {
      if (typeof handle?.[method] !== 'function') return false;
      Promise.resolve(handle[method](...args)).catch(noop);
      return true;
    } catch { return false; }
  };
  const current = (run) => !disposed && !run.invalid
    && entries.get(run.entry.id) === run.entry && run.entry.current === run
    && run.entry.registration.active && providers.get(run.entry.kind) === run.entry.registration
    && state.isCurrent(run.entry.id, run.identity);
  const makeRun = (entry, identity) => ({
    entry, identity, abort: new AbortController(), invalid: false,
    started: false, blocked: false, handle: null, release: null, exitNotified: false,
  });
  const abort = (run) => {
    try { run.abort.abort(); } catch { /* Cleanup must continue even if cancellation throws. */ }
  };
  const release = (run, handle) => {
    if (run.release) return run.release;
    if (handle == null) return Promise.resolve();
    run.handle = null;
    // Schedule disposal after the caller has committed its synchronous state change.
    run.release = track(Promise.resolve().then(() => handle.dispose()));
    run.entry.cleanup = Promise.all([run.entry.cleanup, run.release]).then(noop);
    return run.release;
  };
  const cleanup = (run) => {
    release(run, run.handle);
    return run.entry.cleanup;
  };
  const retire = (run) => {
    run.invalid = true;
    const cleaned = cleanup(run);
    abort(run);
    return cleaned;
  };
  const waitForReopen = (run, cleaned) => {
    const reopen = async () => {
      let waiting = cleaned;
      for (;;) {
        await waiting;
        if (!current(run)) return false;
        // A retired acquisition can arrive while an earlier cleanup is still running.
        if (waiting !== run.entry.cleanup) { waiting = run.entry.cleanup; continue; }
        run.blocked = false;
        start(run);
        return current(run);
      }
    };
    return reopen();
  };
  const visibility = () => {
    for (const entry of [...entries.values()]) {
      const run = entry.current;
      if (current(run) && run.handle) call(run.handle, 'setVisible', state.getSnapshot().activeId === entry.id);
    }
  };
  const fail = (run, reason) => {
    if (!current(run)) return false;
    const code = safeCode(reason);
    if (!current(run)) return false;
    run.invalid = true;
    cleanup(run);
    abort(run);
    return state.setPhase(run.entry.id, run.identity, 'error', code);
  };
  const acquire = (run, handle) => {
    if (!current(run)) return release(run, handle);
    let validHandle = false;
    try { validHandle = !!handle && typeof handle.dispose === 'function'; } catch {}
    if (!validHandle) {
      fail(run, 'TAB_INVALID_HANDLE');
      return release(run, handle);
    }
    // A getter on a foreign handle can invoke application code, so check again.
    if (!current(run)) return release(run, handle);
    run.handle = handle;
    call(handle, 'setVisible', state.getSnapshot().activeId === run.entry.id);
  };
  const start = (run) => {
    if (!current(run) || run.started || run.blocked || run.entry.container == null) return;
    run.started = true;
    // Track acquisition before invoking provider code: onReady/onError can run synchronously.
    let done;
    track(new Promise((resolve) => { done = resolve; }));
    const accept = (handle) => acquire(run, handle);
    const reject = (reason) => { fail(run, reason); };
    try {
      const result = run.entry.registration.provider.open(run.entry.spec, {
        container: run.entry.container,
        signal: run.abort.signal,
        onReady: () => current(run) && state.setPhase(run.entry.id, run.identity, 'ready'),
        onExit: () => {
          if (!current(run) || run.exitNotified) return false;
          run.exitNotified = true;
          try { Promise.resolve(lifecycle.onExit?.(run.entry.id, run.identity)).catch(noop); } catch { /* Exit cleanup remains provider-owned. */ }
          return true;
        },
        onError: (reason) => fail(run, reason),
      });
      if (result != null && typeof result.then === 'function') {
        Promise.resolve(result).then(accept, reject).then(done, (reason) => { reject(reason); done(); });
      } else {
        Promise.resolve(accept(result)).then(done, done);
      }
    } catch (reason) {
      reject(reason);
      done();
    }
  };
  // Ordinary close/retry/revocation await acquired resources, not unresolved opens.
  // dispose() additionally drains every already-started acquisition and its late cleanup.
  const close = (id) => {
    const tab = find(id);
    if (disposed || closing.has(id) || !tab?.closable) return Promise.resolve(false);
    closing.add(id);
    pendingMounts.delete(id);
    const entry = entries.get(id);
    let cleaned = Promise.resolve();
    if (entry) {
      entry.current.invalid = true;
      entries.delete(id);
      cleaned = cleanup(entry.current);
      abort(entry.current);
    }
    const closed = state.close(id);
    if (pendingMounts.get(id)?.identity === tab.identity) pendingMounts.delete(id);
    closing.delete(id);
    visibility();
    return cleaned.then(() => closed);
  };

  return Object.freeze({
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    registerProvider(kind, provider) {
      if (disposed) throw error('TAB_CONTROLLER_DISPOSED');
      if (!kinds.includes(kind)) throw new TypeError('Unsupported tab kind');
      if (!provider || typeof provider.open !== 'function') throw new TypeError('Provider must implement open');
      if (providers.has(kind)) throw error('TAB_PROVIDER_REGISTERED');
      const registration = { provider, active: true, revoked: null };
      providers.set(kind, registration);
      return () => {
        if (registration.revoked) return registration.revoked;
        let done;
        registration.revoked = new Promise((resolve) => { done = resolve; });
        registration.active = false;
        if (providers.get(kind) === registration) providers.delete(kind);
        const owned = [...entries.values()].filter((entry) => entry.registration === registration);
        const waiting = [...pendingMounts.values()].filter((mount) => mount.registration === registration);
        for (const entry of owned) entry.current.invalid = true;
        const ids = new Set([...owned, ...waiting].map((item) => item.id));
        Promise.all([...ids].map(close)).then(done, done);
        return registration.revoked;
      };
    },
    open(spec) {
      if (disposed) return null;
      const snapshot = state.getSnapshot();
      const local = snapshot.tabs.find((tab) => !tab.closable);
      const existing = spec?.kind === 'profile-ui' && local?.profileId !== undefined && spec.profileId === local.profileId
        ? local : snapshot.tabs.find((tab) => tab.kind === spec?.kind && tab.key === spec?.key);
      const registration = providers.get(spec?.kind);
      if (!existing && !registration && spec?.kind !== 'launcher') throw error('TAB_PROVIDER_UNAVAILABLE');
      const ticket = state.reserve(spec);
      if (!ticket) return null;
      // A launcher renders itself and starts no Host, so it needs no provider registration.
      if (ticket.created && !ticket.local && registration) {
        // reserve publishes before the private entry exists; effects can mount or cancel here.
        if (disposed || !state.isCurrent(ticket.id, ticket.identity) || !registration.active || providers.get(spec.kind) !== registration) {
          if (pendingMounts.get(ticket.id)?.identity === ticket.identity) pendingMounts.delete(ticket.id);
          if (state.isCurrent(ticket.id, ticket.identity)) close(ticket.id);
          return null;
        }
        const entry = {
          id: ticket.id, kind: spec.kind, spec, registration,
          container: null, current: null, cleanup: Promise.resolve(),
        };
        entry.current = makeRun(entry, ticket.identity);
        entries.set(entry.id, entry);
        const waiting = pendingMounts.get(entry.id);
        pendingMounts.delete(entry.id);
        if (waiting?.identity === ticket.identity) {
          waiting.entry = entry;
          entry.container = waiting.container;
          start(entry.current);
        }
      } else if (ticket.created && !ticket.local && (disposed || !state.isCurrent(ticket.id, ticket.identity))) {
        if (pendingMounts.get(ticket.id)?.identity === ticket.identity) pendingMounts.delete(ticket.id);
        if (state.isCurrent(ticket.id, ticket.identity)) close(ticket.id);
        return null;
      }
      visibility();
      return ticket.id;
    },
    mount(id, container) {
      const tab = find(id);
      if (disposed || !tab?.closable || container == null) return () => Promise.resolve(false);
      const entry = entries.get(id);
      const registration = entry?.registration || providers.get(tab.kind);
      // A launcher without a provider still exposes its container to an in-place replacement.
      if (!registration?.active && tab.kind !== 'launcher') return () => Promise.resolve(false);
      // During retry publication the state identity is newer than entry.current.
      const identity = tab.identity;
      let attachment = { id, identity, container, entry, registration };
      if (entry) {
        entry.container = container;
        start(entry.current);
      } else {
        const waiting = pendingMounts.get(id);
        if (waiting?.identity === identity && waiting.container === container) attachment = waiting;
        else pendingMounts.set(id, attachment);
      }
      let detached;
      return () => {
        if (!detached) {
          const bound = attachment.entry;
          const mounted = bound ? entries.get(id) === bound && bound.container === container
            : pendingMounts.get(id) === attachment;
          detached = mounted && state.isCurrent(id, identity) ? close(id) : Promise.resolve(false);
        }
        return detached;
      };
    },
    activate(id, { focus = false } = {}) {
      if (disposed || !state.activate(id)) return false;
      visibility();
      const run = entries.get(id)?.current;
      if (focus && state.getSnapshot().activeId === id && run && current(run) && run.handle) {
        call(run.handle, 'focus');
      }
      return true;
    },
    close,
    suspend(id, code = 'TAB_PROVIDER_UNAVAILABLE') {
      const run = entries.get(id)?.current;
      if (!run || !find(id)?.closable) return Promise.resolve(false);
      // Keep the record/spec for retry, but invalidate callbacks and release its Guest.
      if (run.invalid) {
        state.setPhase(id, run.identity, 'error', safeCode(code));
      } else fail(run, code);
      return cleanup(run).then(() => true);
    },
    retry(id) {
      const entry = entries.get(id);
      const tab = find(id);
      if (disposed || !entry || !entry.registration.active || !tab?.closable || tab.kind !== entry.kind) return Promise.resolve(false);
      const previous = entry.current;
      previous.invalid = true;
      const cleaned = cleanup(previous);
      const identity = state.retry(id);
      abort(previous);
      if (identity == null || disposed || entries.get(id) !== entry || !state.isCurrent(id, identity)) {
        return cleaned.then(() => false);
      }
      const run = makeRun(entry, identity);
      run.blocked = true;
      entry.current = run;
      return waitForReopen(run, cleaned);
    },
    // In-place conversion of the current launcher record. The tab keeps its ID, position,
    // and active state; everything else (identity, kind, title, private spec, run) is new.
    replace(id, spec) {
      const tab = find(id);
      if (disposed || !tab || !tab.closable || tab.kind !== 'launcher') return Promise.resolve(false);
      const registration = providers.get(spec?.kind);
      if (!registration?.active) return Promise.resolve(false);
      const entry = entries.get(id);
      const previous = entry?.current || null;
      const ticket = state.replace(id, spec);
      if (!ticket) return Promise.resolve(false);
      const identity = ticket.identity;
      const bail = () => {
        if (previous) retire(previous);
        if (pendingMounts.get(id)?.identity === identity) pendingMounts.delete(id);
        return false;
      };
      if (disposed || !state.isCurrent(id, identity) || entries.get(id) !== entry) return Promise.resolve(bail());
      if (!registration.active || providers.get(spec.kind) !== registration) {
        // The target provider was revoked during publication; mirror unregister and close.
        const closed = close(id);
        return closed.then(() => { if (previous) retire(previous); return false; });
      }
      let cleaned = Promise.resolve();
      if (previous) {
        previous.invalid = true;
        cleaned = cleanup(previous);
        abort(previous);
      }
      const waiting = pendingMounts.get(id);
      pendingMounts.delete(id);
      const container = entry?.container ?? waiting?.container ?? null;
      const target = entry || { id, kind: spec.kind, spec, registration, container: null, current: null, cleanup: Promise.resolve() };
      target.kind = spec.kind;
      target.spec = spec;
      target.registration = registration;
      target.container = container;
      entries.set(id, target);
      const run = makeRun(target, identity);
      run.blocked = true;
      target.current = run;
      if (waiting) waiting.entry = target;
      return waitForReopen(run, cleaned);
    },
    // Reordering only permutes the published array; records, runs, and selection stay put.
    move(id, targetIndex) {
      if (disposed) return false;
      return state.move(id, targetIndex);
    },
    resize(id) {
      const run = entries.get(id)?.current;
      return !!run && current(run) && !!run.handle && call(run.handle, 'resize');
    },
    dispose() {
      if (disposal) return disposal;
      let done;
      disposal = new Promise((resolve) => { done = resolve; });
      disposed = true;
      const owned = [...entries.values()];
      // Invalidate every run before invoking any cancellation or cleanup code.
      for (const entry of owned) entry.current.invalid = true;
      entries.clear();
      pendingMounts.clear();
      for (const registration of providers.values()) registration.active = false;
      providers.clear();
      for (const entry of owned) {
        abort(entry.current);
        cleanup(entry.current);
      }
      try { state.dispose(); } catch { /* Resource cleanup is independent of state observers. */ }
      const drain = async () => {
        while (pending.size) await Promise.all([...pending]);
      };
      drain().then(done, done);
      return disposal;
    },
  });
}
