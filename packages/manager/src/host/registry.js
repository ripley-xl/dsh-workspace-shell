// npm latest-version lookup and SemVer comparison shared by the remote upgrade
// path. Every network or parsing failure collapses to `null`/`false` so the
// caller only ever sees a safe absence of information, never a raw error.

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_NAME_LENGTH = 256;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compares two SemVer strings, including prerelease precedence
 * (`0.2.2-rc.1 < 0.2.2-rc.2 < 0.2.2`). Build metadata is ignored.
 * Returns -1, 0 or 1. Invalid versions raise a TypeError.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a) throw new TypeError(`Invalid version: ${String(left)}`);
  if (!b) throw new TypeError(`Invalid version: ${String(right)}`);
  for (const part of ['major', 'minor', 'patch']) {
    const difference = Math.sign(a[part] - b[part]);
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    // A shorter prerelease list has lower precedence when it is a prefix.
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True only when both versions are valid and `candidate` is strictly newer. */
export function isNewerVersion(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

function validPackageName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH && !/[\0\r\n]/u.test(name);
}

/**
 * Resolves the npm `dist-tags.latest` version of one package. Network errors,
 * non-2xx responses, malformed payloads and timeouts all return `null`.
 */
export async function fetchLatestVersion(name, { fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (!validPackageName(name) || typeof fetchImpl !== 'function') return null;
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('registry request aborted'));
  if (signal) signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('registry request timed out')), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || response.ok !== true) return null;
    const payload = await response.json();
    const latest = payload?.['dist-tags']?.latest;
    return typeof latest === 'string' && parseVersion(latest) ? latest.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

/**
 * Caches npm latest-version results for `ttlMs`. Concurrent lookups for the
 * same package share one request; failed lookups are cached as `null` too, so
 * a registry outage never turns into a request storm.
 */
export function createLatestVersionCache({ fetch: fetchImpl, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  return {
    async latest(name) {
      const key = String(name);
      const cached = entries.get(key);
      const at = now();
      if (cached && at - cached.at < ttlMs) return cached.value;
      if (pending.has(key)) return pending.get(key);
      const request = (async () => {
        const value = await fetchLatestVersion(key, { fetch: fetchImpl });
        entries.set(key, { value, at: now() });
        return value;
      })();
      pending.set(key, request);
      try {
        return await request;
      } finally {
        pending.delete(key);
      }
    },
    clear() {
      entries.clear();
      pending.clear();
    },
  };
}
