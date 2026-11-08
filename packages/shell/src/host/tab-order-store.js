// Host-side tab order: one bounded identity list per DSH profile.
//
// The store opens its storage domain lazily, so a profile without the storage
// backend (or with a backend that fails to open) keeps the Shell usable: reads
// return an empty list and writes report `false`. Limits mirror the Client's
// src/tab-order.js.
//
// The domain schema is deliberately permissive. The storage layer validates every
// stored record while opening the domain, so a strict schema would make one damaged
// order file poison the domain until a restart. This store validates at its own read
// boundary instead, which lets the next write replace the damaged record.
const DOMAIN = Object.freeze({
  name: 'workspace_shell',
  version: 1,
  layout: 'per-record',
  tables: {
    tab_order: { valueSchema: { parse: (value) => value } },
  },
});
const RECORD_KEY = 'default';
const LIMIT = 64;
const TOKEN_LENGTH = 160;
const TOKEN = /^[A-Za-z0-9:._-]{1,160}$/u;
const EMPTY = Object.freeze([]);

// Persisted shape: { version: 1, order: string[] }. Unknown fields are dropped,
// repeated identities collapse, and anything malformed rejects the whole record.
export function validateTabOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tab order must be an object');
  if (value.version !== 1) throw new TypeError('Unsupported tab order version');
  if (!Array.isArray(value.order)) throw new TypeError('Tab order must be an array');
  if (value.order.length > LIMIT) throw new TypeError('Tab order is too long');
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

export function createTabOrderStore({ getStorageDomain } = {}) {
  let opening = null;
  let table = null;
  let unavailable = false;

  async function open() {
    if (table) return table;
    if (unavailable) return null;
    if (!opening) {
      opening = Promise.resolve()
        .then(async () => {
          const storage = typeof getStorageDomain === 'function' ? getStorageDomain() : null;
          if (!storage || typeof storage.open !== 'function') throw new Error('storage unavailable');
          const domain = await storage.open(DOMAIN);
          if (!domain || typeof domain.table !== 'function') throw new Error('storage unavailable');
          return domain.table('tab_order');
        })
        .then((value) => { table = value; return value; })
        .catch(() => { unavailable = true; return null; })
        .finally(() => { opening = null; });
    }
    return opening;
  }

  return Object.freeze({
    domain: DOMAIN,
    // Read the persisted order. Corrupt records and unavailable storage read as empty.
    async read() {
      const current = await open();
      if (!current) return EMPTY;
      try {
        const record = current.get(RECORD_KEY);
        if (!record) return EMPTY;
        return validateTabOrder(record).order;
      } catch {
        return EMPTY;
      }
    },
    // Persist one order. Invalid input throws; storage failure reports false.
    async write(order) {
      const value = validateTabOrder({ version: 1, order });
      const current = await open();
      if (!current) return false;
      try {
        await current.put(RECORD_KEY, value);
        return true;
      } catch {
        return false;
      }
    },
  });
}
