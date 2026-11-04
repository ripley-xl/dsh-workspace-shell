// Observe the public Session prompt boundary without changing admission or draft restoration.
export function observeSessionSubmissions(sessions, { failed, succeeded }) {
  const bindings = new Map();
  let disposed = false;
  function release(id, record) {
    record.active = false;
    if (record.session.prompt === record.wrapper) {
      if (record.descriptor) Object.defineProperty(record.session, 'prompt', record.descriptor);
      else delete record.session.prompt;
    }
    bindings.delete(id);
  }
  function reconcile() {
    if (disposed) return;
    for (const [id, record] of bindings) if (sessions.binding(id)?.session !== record.session) release(id, record);
    for (const id of Object.keys(sessions.list.getSnapshot().byId)) {
      const session = sessions.binding(id)?.session;
      if (!session || bindings.has(id) || typeof session.prompt !== 'function') continue;
      const original = session.prompt;
      const descriptor = Object.getOwnPropertyDescriptor(session, 'prompt');
      const record = { session, descriptor, active: true, sequence: 0 };
      record.wrapper = async function (content, mode, signal, requestId) {
        const sequence = ++record.sequence;
        const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const attachments = content.some((part) => part.type !== 'text');
        const result = await original.call(this, content, mode, signal, requestId);
        if (!disposed && record.active && sequence === record.sequence && !signal?.aborted) {
          // Observer failure must never convert an accepted prompt into a failed send.
          try {
            if (result.ok) succeeded(id);
            else if (result.error?.code === 'session/writer-held') failed(id, { text, attachments });
          } catch { /* Session owns the result and its original error presentation. */ }
        }
        return result;
      };
      Object.defineProperty(session, 'prompt', { configurable: true, writable: true, ...descriptor, value: record.wrapper });
      bindings.set(id, record);
    }
  }
  const off = sessions.list.subscribe(reconcile);
  try { reconcile(); } catch (error) { off(); for (const [id, record] of bindings) release(id, record); throw error; }
  return () => { disposed = true; off(); for (const [id, record] of bindings) release(id, record); };
}

export function applyTransferredDraft(ctx, sessionId, draft, received) {
  if (!draft) return;
  const prior = received.get(draft.id);
  if (prior) {
    if (prior !== sessionId) throw Object.assign(new Error('SESSION_DRAFT_CHANGED'), { code: 'SESSION_DRAFT_CHANGED' });
    return;
  }
  if (received.size >= 1024) throw Object.assign(new Error('SESSION_DRAFT_LIMIT'), { code: 'SESSION_DRAFT_LIMIT' });
  const binding = ctx.sessions.binding(sessionId);
  if (!binding) throw Object.assign(new Error('SESSION_VIEW_CHANGED'), { code: 'SESSION_VIEW_CHANGED' });
  const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt: draft.text, whenDraftExists: 'append' });
  if (result !== 'applied') throw Object.assign(new Error('SESSION_DRAFT_BLOCKED'), { code: 'SESSION_DRAFT_BLOCKED' });
  received.set(draft.id, sessionId);
}
