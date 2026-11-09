// Safe, numeric-only Web open measurements. No URLs, tokens, host names, or errors
// beyond an allowlisted code ever enter the public snapshot.
const TIMING_STAGES = Object.freeze(['input', 'connect', 'instance', 'forward', 'host', 'lease', 'load']);
const TIMING_STAGE_SET = new Set(TIMING_STAGES);
const TIMING_MAX_LIMIT = 16;
const TIMING_MAX_DURATION = 3_600_000;
const TIMING_SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIMING_SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMING_SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function defaultClock() {
  try {
    if (typeof performance === 'object' && performance && typeof performance.now === 'function') return () => performance.now();
  } catch { /* Fall through to wall time. */ }
  return () => Date.now();
}

function timingDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(TIMING_MAX_DURATION, Math.round(value)));
}

export function createWebTiming(options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('Options must be an object');
  const now = typeof options.now === 'function' ? options.now : defaultClock();
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(TIMING_MAX_LIMIT, options.limit)) : 8;
  const listeners = new Set();
  const active = new Map();
  let entries = Object.freeze([]);
  let snapshot = Object.freeze({ entries });
  let sequence = 0;
  let disposed = false;
  const publish = (next) => {
    entries = Object.freeze(next);
    snapshot = Object.freeze({ entries });
    for (const listener of [...listeners]) {
      if (disposed) return;
      if (!listeners.has(listener)) continue;
      try { listener(); } catch { /* One observer must not block the rest. */ }
    }
  };
  const describe = (token) => {
    const stages = [];
    for (const [name, at] of token.marks) stages.push(Object.freeze({ stage: name, at: timingDuration(at - token.started) }));
    return stages;
  };
  const commit = (token, status, code) => {
    if (disposed || token.closed) return false;
    token.closed = true;
    // A newer measurement owning the same view always wins, even when this one settles later.
    const owner = active.get(token.key);
    if (owner && owner !== token) return false;
    active.delete(token.key);
    const stages = describe(token);
    // The private view key stays inside the manager: it can contain a host id and a
    // random component and is not a safe public measurement field.
    const partial = Object.freeze({
      id: token.sequence, kind: token.kind, source: token.source,
      profile: token.profile, reused: token.reused, status,
      ...(code ? { code } : {}), stages: Object.freeze(stages),
      totalMs: timingDuration(now() - token.started),
    });
    publish([partial, ...entries].slice(0, limit));
    return true;
  };
  const begin = (meta = {}) => {
    if (disposed) throw new Error('WEB_TIMING_DISPOSED');
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.key !== 'string' || !TIMING_SAFE_KEY.test(meta.key)) {
      throw new TypeError('A safe measurement key is required');
    }
    const token = {
      key: meta.key, sequence: ++sequence, started: now(), marks: [],
      closed: false, reused: meta.reused === true,
      kind: meta.kind === 'tui' ? 'tui' : meta.kind === 'launcher' ? 'launcher' : 'web',
      source: meta.source === 'ssh' ? 'ssh' : 'local',
      profile: typeof meta.profile === 'string' && TIMING_SAFE_PROFILE.test(meta.profile) ? meta.profile : '',
    };
    const previous = active.get(meta.key);
    if (previous) previous.closed = true;
    active.set(meta.key, token);
    const mark = (stage) => {
      if (token.closed || disposed || !TIMING_STAGE_SET.has(stage)) return false;
      if (token.marks.some(([name]) => name === stage)) return false;
      token.marks.push([stage, now()]);
      return true;
    };
    // Externally measured spans (for example SSH connect/instance/forward) are
    // recorded as absolute offsets from this measurement's start.
    const stage = (name, elapsed) => {
      if (token.closed || disposed || !TIMING_STAGE_SET.has(name)) return false;
      if (!Number.isFinite(elapsed)) return false;
      if (token.marks.some(([entry]) => entry === name)) return false;
      token.marks.push([name, token.started + timingDuration(elapsed)]);
      token.marks.sort((left, right) => left[1] - right[1]);
      return true;
    };
    const handle = Object.freeze({
      mark,
      stage,
      finish(extra = {}) {
        if (extra && extra.reused === true) token.reused = true;
        return commit(token, 'ready');
      },
      fail(cause) {
        const code = typeof cause === 'string' ? cause : cause?.code;
        return commit(token, 'failed', TIMING_SAFE_CODE.test(code ?? '') ? code : 'WEB_OPEN_FAILED');
      },
    });
    return handle;
  };
  const invalidate = (key) => {
    if (typeof key !== 'string') return false;
    const token = active.get(key);
    if (!token) return false;
    token.closed = true;
    active.delete(key);
    return true;
  };
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin,
    invalidate,
    clear() { if (!disposed && entries.length) publish([]); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const token of active.values()) token.closed = true;
      active.clear();
      listeners.clear();
    },
  });
}

export const webTimingStages = TIMING_STAGES;
