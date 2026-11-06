/**
 * Ordering for DSH release versions.
 *
 * The manager holds the local Desktop version and the version reported by the
 * remote Host. It only updates a remote Host that is behind the local version,
 * so it needs a direction instead of an equality test:
 *
 *   - `X.Y.Z` core numbers compare numerically;
 *   - a pre-release sorts before its release (`0.2.2-rc.1` < `0.2.2`);
 *   - pre-release identifiers compare by semver rules (numeric identifiers
 *     numerically and before alphanumeric ones, others in ASCII order);
 *   - `+build` metadata is ignored.
 *
 * Anything that is not a complete `X.Y.Z[-pre][+build]` version returns `null`
 * so callers can treat the comparison as "unknown" instead of guessing.
 */

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const NUMERIC_IDENTIFIER = /^\d+$/u;

function parseDshVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) {
    const difference = Number(left) - Number(right);
    return difference === 0 ? 0 : difference < 0 ? -1 : 1;
  }
  // Numeric identifiers always sort before alphanumeric identifiers.
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePreRelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  // A release sorts after any of its pre-releases.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const result = compareIdentifier(left[index], right[index]);
    if (result !== 0) return result;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/**
 * Compares two DSH versions.
 * @returns {-1|0|1|null} -1 when `left` is older, 0 when equal, 1 when newer,
 * and `null` when either value is not a comparable version.
 */
export function compareDshVersions(left, right) {
  const first = parseDshVersion(left);
  const second = parseDshVersion(right);
  if (!first || !second) return null;
  for (let index = 0; index < 3; index += 1) {
    if (first.core[index] !== second.core[index]) return first.core[index] < second.core[index] ? -1 : 1;
  }
  return comparePreRelease(first.pre, second.pre);
}
