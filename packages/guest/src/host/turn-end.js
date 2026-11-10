// Turn-end context for notifications.
//
// A page learns that a Session stopped running from its status store, but that
// store carries no reply text and no failure reason. This Host-side tracker
// keeps the last assistant text and the Turn-end reason per Session so the
// notification can say what the Turn produced. It runs in every Host that
// mounts the shared session-host plugin: the Desktop profile and each Web Guest.
const MAX_TEXT = 200;
const MAX_ENTRIES = 256;
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SESSION_ID = 128;

function collapsed(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1).trimEnd() + '…' : text;
}

function replyText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block?.type !== 'text') continue;
    const text = collapsed(block.text);
    if (text) return text;
  }
  return '';
}

function errorText(reason) {
  const message = reason?.error?.message ?? reason?.message;
  return collapsed(typeof message === 'string' ? message : '');
}

// `subscribe` receives one `(session, event)` sink and returns its disposer.
export function createTurnEndTracker({ subscribe, now = () => Date.now(), maxAge = MAX_AGE_MS } = {}) {
  const replies = new Map();
  const ends = new Map();
  const prune = () => {
    const cutoff = now() - maxAge;
    for (const [id, row] of ends) if (row.at < cutoff) ends.delete(id);
    while (ends.size > MAX_ENTRIES) {
      const oldest = ends.keys().next().value;
      if (oldest === undefined) break;
      ends.delete(oldest);
    }
  };
  const onEvent = (session, event) => {
    const id = session?.header?.id ?? session?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SESSION_ID) return;
    if (event?.type === 'assistant/message') {
      const text = replyText(event);
      if (text) replies.set(id, text);
      return;
    }
    if (event?.type !== 'turn/end') return;
    const reason = event?.data?.reason;
    ends.set(id, {
      reason: typeof reason?.kind === 'string' && reason.kind.length > 0 ? reason.kind : 'other',
      text: replies.get(id) ?? '',
      error: errorText(reason),
      at: now(),
    });
    replies.delete(id);
    prune();
  };
  const off = typeof subscribe === 'function' ? subscribe(onEvent) : () => {};
  return {
    read(sessionId) {
      const row = ends.get(sessionId);
      if (!row) return null;
      return { reason: row.reason, text: row.text, error: row.error };
    },
    dispose() {
      try {
        off();
      } catch {
        // Detaching from a disposed Host is best effort.
      }
      replies.clear();
      ends.clear();
    },
  };
}
