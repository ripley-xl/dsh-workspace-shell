// Host-side workspace tab preferences: one bounded order list and one bounded
// display-appearance list per DSH profile.
//
// The store opens its storage domain lazily, so a profile without the storage
// backend (or with a backend that fails to open) keeps the Shell usable: reads
// return empty values, appearance reports `available: false`, and writes report
// `false`. Limits are shared with the Client modules where practical.
//
// The domain schema is deliberately permissive. The storage layer validates
// every stored record while opening the domain, so a strict schema would make
// one damaged preference poison the domain until a restart. This store
// validates at its own read boundary instead, which lets the next write
// replace the damaged record.
import {
  TAB_APPEARANCE_COLORS,
  TAB_APPEARANCE_LIMIT,
  TAB_APPEARANCE_NAME_MAX,
} from '../tab-appearance.js';

const DOMAIN = Object.freeze({
  name: 'workspace_shell',
  version: 1,
  layout: 'per-record',
  tables: {
    tab_order: { valueSchema: { parse: (value) => value } },
    tab_appearance: { valueSchema: { parse: (value) => value } },
  },
});
const RECORD_KEY = 'default';
const ORDER_LIMIT = 64;
const TOKEN_LENGTH = 160;
const TOKEN = /^[A-Za-z0-9:._-]{1,160}$/u;
const COLOR_IDS = new Set(TAB_APPEARANCE_COLORS);
const EMPTY = Object.freeze([]);

// Persisted shape: { version: 1, order: string[] }. Unknown fields are dropped,
// repeated identities collapse, and anything malformed rejects the whole record.
export function validateTabOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tab order must be an object');
  if (value.version !== 1) throw new TypeError('Unsupported tab order version');
  if (!Array.isArray(value.order)) throw new TypeError('Tab order must be an array');
  if (value.order.length > ORDER_LIMIT) throw new TypeError('Tab order is too long');
  const seen = new Set();
  const order = [];
  for (const item of value.order) {
    if (typeof item !== 'string' || item.length > TOKEN_LENGTH || !TOKEN.test(item)) throw new TypeError('Invalid tab identity');
    if (seen.has(item)) continue;
    seen.add(item);
    order.push(item);
  }
  return Object.freeze({ version: 1, order: Object.freeze(order) });
}

function appearanceName(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('Tab appearance name must be a string');
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > TAB_APPEARANCE_NAME_MAX || /[\0\r\n]/u.test(name)) {
    throw new TypeError(`Tab appearance name must be a single line of at most ${TAB_APPEARANCE_NAME_MAX} characters`);
  }
  return name;
}

function appearanceColor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !COLOR_IDS.has(value)) throw new TypeError('Unsupported tab appearance color');
  return value;
}

// Persisted shape:
// { version: 1, entries: [{ id, name?, color? }] }. The record stores display
// information only; no host alias, URL, working directory, or session content.
export function validateTabAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tab appearance must be an object');
  if (value.version !== 1) throw new TypeError('Unsupported tab appearance version');
  if (!Array.isArray(value.entries)) throw new TypeError('Tab appearance entries must be an array');
  if (value.entries.length > TAB_APPEARANCE_LIMIT) throw new TypeError('Tab appearance is too long');
  const records = new Map();
  for (const item of value.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Tab appearance entry must be an object');
    const { id } = item;
    if (typeof id !== 'string' || id.length > TOKEN_LENGTH || !TOKEN.test(id)) throw new TypeError('Invalid tab identity');
    const name = appearanceName(item.name);
    const color = appearanceColor(item.color);
    if (name === undefined && color === undefined) continue;
    // Re-insert so the client's least-recently edited entries sort the same way.
    if (records.has(id)) records.delete(id);
    records.set(id, Object.freeze({ id, ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) }));
  }
  return Object.freeze({ version: 1, entries: Object.freeze([...records.values()]) });
}

export function createWorkspacePreferencesStore({ getStorageDomain } = {}) {
  let opening = null;
  let tables = null;
  let unavailable = false;

  async function open() {
    if (tables) return tables;
    if (unavailable) return null;
    if (!opening) {
      opening = Promise.resolve()
        .then(async () => {
          const storage = typeof getStorageDomain === 'function' ? getStorageDomain() : null;
          if (!storage || typeof storage.open !== 'function') throw new Error('storage unavailable');
          const domain = await storage.open(DOMAIN);
          if (!domain || typeof domain.table !== 'function') throw new Error('storage unavailable');
          return Object.freeze({ order: domain.table('tab_order'), appearance: domain.table('tab_appearance') });
        })
        .then((value) => { tables = value; return value; })
        .catch(() => { unavailable = true; return null; })
        .finally(() => { opening = null; });
    }
    return opening;
  }

  return Object.freeze({
    domain: DOMAIN,
    // Read the persisted order. Corrupt records and unavailable storage read as empty.
    async readOrder() {
      const current = await open();
      if (!current) return EMPTY;
      try {
        const record = current.order.get(RECORD_KEY);
        if (!record) return EMPTY;
        return validateTabOrder(record).order;
      } catch {
        return EMPTY;
      }
    },
    // Persist one order. Invalid input throws; storage failure reports false.
    async writeOrder(order) {
      const value = validateTabOrder({ version: 1, order });
      const current = await open();
      if (!current) return false;
      try {
        await current.order.put(RECORD_KEY, value);
        return true;
      } catch {
        return false;
      }
    },
    // Appearance reports whether the storage backend opened. A malformed record
    // still reports available so the next save can replace it; an unreadable
    // backend reports unavailable so the Client does not overwrite unseen data.
    async readAppearance() {
      const current = await open();
      if (!current) return Object.freeze({ entries: EMPTY, available: false });
      let record;
      try {
        record = current.appearance.get(RECORD_KEY);
      } catch {
        return Object.freeze({ entries: EMPTY, available: false });
      }
      if (!record) return Object.freeze({ entries: EMPTY, available: true });
      try {
        return Object.freeze({ entries: validateTabAppearance(record).entries, available: true });
      } catch {
        return Object.freeze({ entries: EMPTY, available: true });
      }
    },
    // Persist the complete appearance list. Invalid input throws; storage failure reports false.
    async writeAppearance(entries) {
      const value = validateTabAppearance({ version: 1, entries });
      const current = await open();
      if (!current) return false;
      try {
        await current.appearance.put(RECORD_KEY, value);
        return true;
      } catch {
        return false;
      }
    },
  });
}
