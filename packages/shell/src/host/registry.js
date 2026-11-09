// npm registry version helpers for the local Host upgrade path. Kept free of
// Node-only imports so tests can drive it with a fake `fetch` and fake clock.

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const VERSION = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const a = Number(left);
    const b = Number(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * semver precedence including prerelease and ignoring build metadata.
 * Non-semver inputs fall back to an ordinary string comparison so callers
 * still get a stable -1/0/1; they never throw on registry data.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    const x = typeof left === 'string' ? left : '';
    const y = typeof right === 'string' ? right : '';
    return x === y ? 0 : x < y ? -1 : 1;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  // A release outranks any prerelease of the same core version.
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const order = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/** `true` only when both versions are known and `candidate` is higher. */
export function isNewerVersion(candidate, current) {
  if (typeof candidate !== 'string' || typeof current !== 'string') return false;
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}

function registryUrl(name) {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
}

/**
 * Reads `dist-tags.latest` for one package. Any failure (network, abort,
 * timeout, malformed payload, missing tag) resolves to `null`: callers treat
 * that as "no version known", never as an error string.
 */
export async function fetchLatestVersion(name, { fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) return null;
  const request = fetchImpl ?? globalThis.fetch;
  if (typeof request !== 'function') return null;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return null;
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await request(registryUrl(name), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response?.ok) return null;
    const payload = await response.json();
    const latest = payload?.['dist-tags']?.latest;
    return typeof latest === 'string' && latest.trim() ? latest.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * TTL cache in front of `fetchLatestVersion`. `latest(name)` is the only
 * accessor: concurrent callers share one request, and `null` results are
 * cached too so an unreachable registry is not retried on every render.
 */
export function createLatestVersionCache({ fetch: fetchImpl, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be a non-negative integer');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const entries = new Map();
  const pending = new Map();
  async function latest(name) {
    const cached = entries.get(name);
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const running = pending.get(name);
    if (running) return running;
    const request = (async () => {
      const value = await fetchLatestVersion(name, { fetch: fetchImpl });
      entries.set(name, { at: now(), value });
      return value;
    })().finally(() => { pending.delete(name); });
    pending.set(name, request);
    return request;
  }
  function clear() {
    entries.clear();
    pending.clear();
  }
  return { latest, clear };
}
