import { randomUUID } from 'node:crypto';
import { sessionIds, sessionHostError } from './session-hosts.js';

const token = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const fail = () => { throw sessionHostError('SESSION_VIEW_CHANGED'); };

// View ids are fresh per Client activation; neither tab titles nor profile names address a view.
export function createSessionViewBroker({ now = Date.now, ttl = 15000, deadline = 60000 } = {}) {
  const views = new Map();
  let disposed = false;
  function remove(id) {
    const view = views.get(id);
    views.delete(id);
    view?.pending?.finish(sessionHostError('SESSION_VIEW_CHANGED'));
  }
  function prune() {
    for (const [id, view] of views) if (now() - view.seen > ttl) remove(id);
  }
  return {
    update(input) {
      prune();
      if (disposed || !token(input.viewId) || !token(input.windowId) || !(input.tabId === 'local' || token(input.tabId))) fail();
      if (input.sessionId !== null) sessionIds([input.sessionId]);
      let view = views.get(input.viewId);
      if (view && (view.windowId !== input.windowId || view.tabId !== input.tabId)) fail();
      if (!view) {
        if (views.size >= 128) throw sessionHostError('SESSION_VIEW_LIMIT');
        views.set(input.viewId, view = { viewId: input.viewId, windowId: input.windowId, tabId: input.tabId });
      }
      Object.assign(view, { sessionId: input.sessionId, seen: now(), active: input.active === true });
      if (view.active) view.used = now();
      return { command: view.pending ? { requestId: view.pending.requestId, ...view.pending.command } : null };
    },
    list(windowId) {
      prune();
      if (!token(windowId)) fail();
      return [...views.values()].filter((view) => view.windowId === windowId).map(({ viewId, windowId, tabId, sessionId, used = 0 }) => ({ viewId, windowId, tabId, sessionId, used }));
    },
    command(viewId, command, signal) {
      prune();
      const view = views.get(viewId);
      if (disposed || signal?.aborted || !view || !['select', 'goto'].includes(command?.kind)) fail();
      sessionIds([command.sessionId]);
      if (command.kind === 'goto' && (view.tabId !== 'local' || !token(command.instanceId))) fail();
      const draft = command.draft;
      if (draft !== undefined && (!token(draft?.id) || typeof draft.text !== 'string' || Buffer.byteLength(JSON.stringify(draft)) > 48 * 1024)) throw sessionHostError('SESSION_DRAFT_INVALID');
      view.pending?.finish(sessionHostError('SESSION_NAVIGATION_SUPERSEDED'));
      return new Promise((resolve, reject) => {
        const requestId = randomUUID().replaceAll('-', '');
        const abort = () => finish(sessionHostError('SESSION_NAVIGATION_CANCELLED'));
        const timer = setTimeout(() => finish(sessionHostError('SESSION_NAVIGATION_TIMEOUT')), deadline);
        const finish = (error, receipt) => {
          if (view.pending?.requestId !== requestId) return;
          view.pending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(receipt);
        };
        view.pending = { requestId, command: { kind: command.kind, sessionId: command.sessionId, ...(command.kind === 'goto' ? { instanceId: command.instanceId } : {}), ...(draft ? { draft: { id: draft.id, text: draft.text } } : {}) }, finish };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    acknowledge(input) {
      prune();
      const view = views.get(input.viewId);
      const pending = view?.pending;
      if (!pending || pending.requestId !== input.requestId || pending.command.sessionId !== input.sessionId) fail();
      if (input.cancelled === true && pending.command.kind === 'goto') pending.finish(null, { viewId: view.viewId, requestId: pending.requestId, sessionId: input.sessionId, cancelled: true });
      else if (input.ok !== true) pending.finish(sessionHostError(['SESSION_DRAFT_BLOCKED', 'SESSION_DRAFT_LIMIT', 'SESSION_HOST_CHANGED'].includes(input.code) ? input.code : 'SESSION_NAVIGATION_FAILED'));
      else if (pending.command.kind === 'select' && view.sessionId !== input.sessionId) fail();
      else if (pending.command.draft && input.draftId !== pending.command.draft.id) fail();
      else pending.finish(null, { viewId: view.viewId, requestId: pending.requestId, sessionId: input.sessionId, ...(pending.command.draft ? { draftId: pending.command.draft.id } : {}) });
      return { accepted: true };
    },
    remove,
    dispose() { disposed = true; for (const id of [...views.keys()]) remove(id); },
  };
}
