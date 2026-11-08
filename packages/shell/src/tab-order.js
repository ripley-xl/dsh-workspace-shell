// Remembered tab order: bounded identity tokens only, never titles, URLs, tokens,
// working directories, or session content.
//
// The Host validator in src/host/tab-order-store.js uses the same limits; keep
// both copies in sync. This module stays import-free because the Shell build
// concatenates it with the rest of the Client.
const DEFAULT_LIMIT = 64;
const DEFAULT_TOKEN_LENGTH = 160;
const TOKEN = /^[A-Za-z0-9:._-]{1,160}$/u;

function sameOrder(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// Accept both the bare array and the Host envelope, then drop invalid or repeated
// tokens. A corrupted preference degrades to "append", never to an error.
function normalized(value, limit, tokenLength) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.order) ? value.order : null;
  if (!source) return [];
  const seen = new Set();
  const order = [];
  for (const item of source) {
    if (order.length >= limit) break;
    if (typeof item !== 'string' || item.length > tokenLength || !TOKEN.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    order.push(item);
  }
  return order;
}

export function createTabOrderMemory(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const limit = Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 512 ? input.limit : DEFAULT_LIMIT;
  const tokenLength = Number.isInteger(input.maxToken) && input.maxToken > 0 && input.maxToken <= 1024
    ? input.maxToken
    : DEFAULT_TOKEN_LENGTH;
  let order = Object.freeze([]);
  let disposed = false;

  function valid(identity) {
    return typeof identity === 'string' && identity.length <= tokenLength && TOKEN.test(identity);
  }

  function apply(next) {
    if (sameOrder(order, next)) return false;
    order = Object.freeze(next);
    return true;
  }

  return Object.freeze({
    // Load a persisted order. The newest snapshot replaces the previous one.
    hydrate(value) {
      if (disposed) return false;
      return apply(normalized(value, limit, tokenLength));
    },
    rankOf(identity) {
      if (disposed || !valid(identity)) return -1;
      return order.indexOf(identity);
    },
    // Index the tab should occupy among `slots`, which are the identities of the
    // tabs already on screen in display order (null for unremembered tabs).
    insertionIndex(identity, slots) {
      const list = Array.isArray(slots) ? slots : [];
      if (disposed || !valid(identity)) return list.length;
      const rank = order.indexOf(identity);
      if (rank < 0) return list.length;
      let index = 0;
      for (let position = 0; position < list.length; position += 1) {
        const slot = list[position];
        if (slot === identity) {
          // Multiple tabs of one family stay adjacent, in arrival order.
          index = position + 1;
          continue;
        }
        if (!valid(slot)) continue;
        const other = order.indexOf(slot);
        if (other >= 0 && other < rank) index = position + 1;
      }
      return Math.min(Math.max(index, 0), list.length);
    },
    // Fold the displayed identities into the remembered order. Closed identities keep
    // their slots so reopening a tab returns it to the familiar place; new identities
    // append. Overflow evicts closed identities from the left first.
    sync(slots) {
      if (disposed) return false;
      const list = Array.isArray(slots) ? slots : [];
      const open = [];
      const present = new Set();
      for (const item of list) {
        if (!valid(item) || present.has(item)) continue;
        present.add(item);
        open.push(item);
      }
      const next = [...order];
      const positions = [];
      for (let index = 0; index < next.length; index += 1) {
        if (present.has(next[index])) positions.push(index);
      }
      for (let index = 0; index < positions.length && index < open.length; index += 1) {
        next[positions[index]] = open[index];
      }
      for (let index = positions.length; index < open.length; index += 1) {
        next.push(open[index]);
      }
      while (next.length > limit) {
        const closed = next.findIndex((identity) => !present.has(identity));
        next.splice(closed >= 0 ? closed : 0, 1);
      }
      return apply(next);
    },
    snapshot() {
      return order;
    },
    dispose() {
      disposed = true;
      order = Object.freeze([]);
    },
  });
}
