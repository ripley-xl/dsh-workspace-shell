// Per-profile tab display preferences: a stable workspace identity maps to a
// custom label and one palette color. Import-free because the Shell build
// concatenates this module into the generated Client.
//
// The Host validator in src/host/workspace-preferences-store.js imports the
// same palette and limits, so persisted records and the editor cannot drift.
//
// Nothing here knows about host records, URLs, working directories, or session
// content: an appearance is identity, an optional name, and an optional color.
export const TAB_APPEARANCE_COLORS = Object.freeze(['blue', 'green', 'amber', 'red', 'gray']);
export const TAB_APPEARANCE_LIMIT = 64;
export const TAB_APPEARANCE_NAME_MAX = 64;

const TOKEN = /^[A-Za-z0-9:._-]{1,160}$/u;
const TOKEN_LENGTH = 160;
const COLOR_IDS = new Set(TAB_APPEARANCE_COLORS);
const EMPTY = Object.freeze([]);

function validIdentity(identity) {
  return typeof identity === 'string' && identity.length <= TOKEN_LENGTH && TOKEN.test(identity);
}

function normalizeName(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('Tab appearance name must be a string');
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > TAB_APPEARANCE_NAME_MAX || /[\0\r\n]/u.test(name)) {
    throw new TypeError(`Tab appearance name must be a single line of at most ${TAB_APPEARANCE_NAME_MAX} characters`);
  }
  return name;
}

function normalizeColor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !COLOR_IDS.has(value)) throw new TypeError('Unsupported tab appearance color');
  return value;
}

// Internal map values omit the identity; entries() re-adds it for the wire.
function entryOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tab appearance entry must be an object');
  const name = normalizeName(value.name);
  const color = normalizeColor(value.color);
  if (name === undefined && color === undefined) return null;
  return Object.freeze({ ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) });
}

function sameEntry(left, right) {
  if (!left || !right) return left === right;
  return left.name === right.name && left.color === right.color;
}

function listOf(entries) {
  return Object.freeze(entries.map(([id, value]) => Object.freeze({ id, ...value })));
}

// Tolerant read path: malformed records are skipped instead of failing the
// whole preference. Unknown fields are not copied into the result.
function normalizedEntries(value, limit = TAB_APPEARANCE_LIMIT) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.entries) ? value.entries : null;
  if (!source) return [];
  const records = new Map();
  for (const item of source) {
    if (records.size >= limit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!validIdentity(item.id)) continue;
    let entry;
    try { entry = entryOf(item); } catch { continue; }
    if (!entry) continue;
    records.set(item.id, entry);
  }
  return [...records];
}

export function createTabAppearanceMemory(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const limit = Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 512
    ? Math.min(input.limit, TAB_APPEARANCE_LIMIT)
    : TAB_APPEARANCE_LIMIT;
  let records = new Map();
  let snapshot = EMPTY;
  let disposed = false;

  function apply(next) {
    records = next;
    snapshot = listOf([...records]);
    return true;
  }

  function sameRecords(next) {
    if (next.size !== records.size) return false;
    for (const [id, entry] of next) {
      if (!sameEntry(records.get(id), entry)) return false;
    }
    return true;
  }

  return Object.freeze({
    colors: TAB_APPEARANCE_COLORS,
    limit,
    // Load persisted entries. Invalid items are dropped and a malformed
    // envelope reads as empty; this never throws on stored data.
    hydrate(value) {
      if (disposed) return false;
      const next = new Map(normalizedEntries(value, limit));
      if (sameRecords(next)) return false;
      return apply(next);
    },
    get(identity) {
      if (disposed || !validIdentity(identity)) return null;
      return records.get(identity) ?? null;
    },
    // Compute the next persisted list without mutating the live memory. The
    // caller writes this list first and commits only after the Host saved it.
    prepare(identity, value) {
      if (disposed || !validIdentity(identity)) return Object.freeze({ changed: false, entries: snapshot });
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tab appearance must be an object');
      const entry = entryOf(value);
      const previous = records.get(identity) ?? null;
      if (sameEntry(previous, entry)) return Object.freeze({ changed: false, entries: snapshot });
      const next = new Map(records);
      // Re-insert so the least recently edited identity is evicted first.
      if (next.has(identity)) next.delete(identity);
      if (entry) next.set(identity, entry);
      while (next.size > limit) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return Object.freeze({ changed: true, entries: listOf([...next]) });
    },
    entries() {
      return snapshot;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      records = new Map();
      snapshot = EMPTY;
    },
  });
}
