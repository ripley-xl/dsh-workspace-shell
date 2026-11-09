const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (code) => Object.assign(new Error(code), { code });

export function createSessionHostClient({ ctx, window, applyDraft }) {
  const lifetime = new AbortController();
  const viewId = window.crypto.randomUUID().replaceAll('-', '');
  const params = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams((window.location.hash ?? '').slice(1));
  for (const name of ['workspaceShellEmbedded', 'workspaceSessionWindow', 'workspaceSessionParent', 'workspaceSessionTab']) {
    if (!params.has(name) && fragment.has(name)) params.set(name, fragment.get(name));
  }
  const embedded = params.get('workspaceShellEmbedded') === '1';
  const parentView = params.get('workspaceSessionWindow');
  const parentHost = params.get('workspaceSessionParent');
  const tabId = params.get('workspaceSessionTab');
  const registered = !embedded || [parentView, parentHost, tabId].every(validToken);
  const windowId = embedded ? parentView : viewId;
  const listeners = new Set();
  let snapshot = { host: null, failures: {}, incoming: {} };
  let timer, activeCommand, navigation;
  const commandIds = new Set();
  const received = new Map();
  const publish = (next) => { if (lifetime.signal.aborted) return; snapshot = { ...snapshot, ...next }; for (const fn of listeners) { try { fn(); } catch {} } };
  async function api(route, input, signal = lifetime.signal) {
    const response = await window.fetch('/api/workspace-session-hosts/' + route, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.any([signal, lifetime.signal]) });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) throw fail(body?.error?.code ?? 'SESSION_HOST_UNAVAILABLE');
    return body.result;
  }
  const currentSession = () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return null;
    const entries = Object.values(ctx.sessions.list.getSnapshot().byId).filter((row) => (row.retainedBy?.mainView ?? 0) > 0);
    return entries.length === 1 ? entries[0].id : null;
  };
  const updateView = () => api('view/update', { viewId, windowId, tabId: embedded ? tabId : 'local', sessionId: currentSession(), active: window.document.visibilityState === 'visible' && window.document.hasFocus() });
  async function status(ids, signal) {
    const value = await api('status', { sessionIds: ids }, signal);
    if (signal?.aborted || lifetime.signal.aborted) throw fail('SESSION_NAVIGATION_CANCELLED');
    if (snapshot.host && value.host.instanceId !== snapshot.host.instanceId) throw fail('SESSION_HOST_CHANGED');
    publish({ host: value.host });
    return value;
  }
  const updateFailure = (id, current, fields) => {
    if (snapshot.failures[id]?.id === current.id) publish({ failures: { ...snapshot.failures, [id]: { ...snapshot.failures[id], ...fields } } });
  };
  const offPanel = ctx.layout.panelInfo.subscribe(() => navigation?.abort());
  async function refresh(id) {
    const current = snapshot.failures[id];
    if (!current) return;
    try {
      const value = await status([id]);
      const owner = value.sessions[id] ?? { state: 'unknown' };
      let action = 'go';
      if (owner.state === 'foreign') {
        const candidates = await api('views', { instanceId: owner.host.instanceId, windowId });
        const shell = ctx.get('workspaceShell');
        const tokens = new Set(shell?.sessionTabs?.().map((tab) => tab.token) ?? []);
        if (!candidates.some((view) => embedded || tokens.has(view.tabId))) action = 'open';
      }
      updateFailure(id, current, { owner, action, checking: false });
    } catch {
      updateFailure(id, current, { owner: { state: 'unavailable' }, checking: false });
    }
  }
  function failed(id, { text, attachments }) {
    navigation?.abort();
    const failures = { ...snapshot.failures, [id]: { id: window.crypto.randomUUID().replaceAll('-', ''), text, attachments, checking: true, owner: { state: 'unknown' } } };
    const incoming = { ...snapshot.incoming };
    delete incoming[id];
    if (Object.keys(failures).length > 32) delete failures[Object.keys(failures)[0]];
    publish({ failures, incoming });
    void refresh(id);
  }
  function dismiss(id) {
    navigation?.abort();
    const failures = { ...snapshot.failures }, incoming = { ...snapshot.incoming };
    delete failures[id]; delete incoming[id]; publish({ failures, incoming });
  }
  async function verify(instanceId, sessionId, signal) {
    const value = await status([sessionId], signal);
    const owner = value.sessions[sessionId];
    if (!owner?.host || owner.host.instanceId !== instanceId) throw fail('SESSION_HOST_CHANGED');
    return owner.host;
  }
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(fail('SESSION_NAVIGATION_CANCELLED')); return; }
    const abort = () => { clearTimeout(timer); reject(fail('SESSION_NAVIGATION_CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
  async function select(sessionId, signal, draft) {
    await verify(snapshot.host.instanceId, sessionId, signal);
    if (signal.aborted) throw fail('SESSION_NAVIGATION_CANCELLED');
    ctx.uiWorkspace.openSession(sessionId);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (currentSession() === sessionId) {
        // Selection and initial history opening must both finish before acknowledgment.
        const reference = ctx.sessions.retain(sessionId, { source: 'workspace-session-navigation', signal });
        try { await reference.ready; } finally { reference.release(); }
        if (signal.aborted || currentSession() !== sessionId) throw fail('SESSION_NAVIGATION_CANCELLED');
        await verify(snapshot.host.instanceId, sessionId, signal);
        if (signal.aborted || currentSession() !== sessionId) throw fail('SESSION_NAVIGATION_CANCELLED');
        applyDraft(ctx, sessionId, draft, received);
        if (draft) publish({ incoming: { ...snapshot.incoming, [sessionId]: true } });
        await updateView(); return;
      }
      await delay(100, signal);
    }
    throw fail('SESSION_NAVIGATION_TIMEOUT');
  }
  async function go(instanceId, sessionId, signal, draft) {
    const owner = await verify(instanceId, sessionId, signal);
    const shell = ctx.get('workspaceShell');
    if (embedded) {
      if (!registered) throw fail('SESSION_PARENT_UNAVAILABLE');
      const receipt = await api('command', { instanceId: parentHost, viewId: parentView, command: { kind: 'goto', instanceId, sessionId, draft } }, signal);
      if (receipt.cancelled === true) throw fail('SESSION_NAVIGATION_CANCELLED');
      if (receipt.sessionId !== sessionId || draft && receipt.draftId !== draft.id) throw fail('SESSION_HOST_CHANGED');
      return true;
    }
    if (!shell?.sessionTabs || !shell?.openSessionHost) throw fail('SESSION_PARENT_UNAVAILABLE');
    const sourceId = shell.getSnapshot().activeId;
    let createdId;
    try {
      let candidates = await api('views', { instanceId, windowId }, signal);
      const liveTabs = () => new Map(shell.sessionTabs().map((tab) => [tab.token, tab]));
      candidates = candidates.filter((view) => view.tabId === 'local' ? instanceId === snapshot.host.instanceId && view.viewId === viewId : liveTabs().has(view.tabId));
      candidates.sort((a, b) => Number(b.sessionId === sessionId) - Number(a.sessionId === sessionId) || b.used - a.used);
      let target = candidates[0];
      if (!target) {
        if (!owner.canAttach) throw fail('SESSION_HOST_NOT_ATTACHABLE');
        await verify(instanceId, sessionId, signal);
        if (signal.aborted) throw fail('SESSION_NAVIGATION_CANCELLED');
        createdId = await shell.openSessionHost({ instanceId, sessionId, profile: owner.profile });
        for (let attempt = 0; attempt < 150; attempt++) {
          if (!shell.getSnapshot().tabs.some((tab) => tab.id === createdId)) throw fail('SESSION_VIEW_CHANGED');
          const bindings = liveTabs();
          const views = await api('views', { instanceId, windowId }, signal);
          target = views.find((view) => bindings.get(view.tabId)?.id === createdId);
          if (target) break;
          await delay(200, signal);
        }
        if (!target) throw fail('SESSION_VIEW_UNAVAILABLE');
      }
      const binding = target.tabId === 'local' ? { id: 'local' } : liveTabs().get(target.tabId);
      if (!binding) throw fail('SESSION_VIEW_CHANGED');
      await verify(instanceId, sessionId, signal);
      if (target.viewId === viewId) await select(sessionId, signal, draft);
      else {
        const receipt = await api('command', { instanceId, viewId: target.viewId, command: { kind: 'select', sessionId, draft } }, signal);
        if (receipt.viewId !== target.viewId || receipt.sessionId !== sessionId || draft && receipt.draftId !== draft.id) throw fail('SESSION_HOST_CHANGED');
      }
      if (signal.aborted || (binding.id !== 'local' && liveTabs().get(target.tabId)?.identity !== binding.identity)) throw fail('SESSION_VIEW_CHANGED');
      if (![sourceId, createdId].includes(shell.getSnapshot().activeId)) throw fail('SESSION_NAVIGATION_CANCELLED');
      if (!await shell.activate(binding.id)) throw fail('SESSION_VIEW_CHANGED');
      return true;
    } catch (error) {
      if (createdId && shell.getSnapshot().activeId === createdId) await shell.activate(sourceId);
      throw error;
    }
  }
  async function navigate(sessionId) {
    const current = snapshot.failures[sessionId];
    if (!current || current.navigating || currentSession() !== sessionId || current.owner?.state !== 'foreign') return;
    navigation?.abort();
    const abort = navigation = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.signal, ctx.layout.beginNavigation()]);
    updateFailure(sessionId, current, { navigating: true, error: null, transferred: false });
    try {
      const draft = current.text ? { id: current.id, text: current.text } : undefined;
      if (draft && new TextEncoder().encode(JSON.stringify(draft)).byteLength > 48 * 1024) throw fail('SESSION_DRAFT_TOO_LARGE');
      await go(current.owner.host.instanceId, sessionId, signal, draft);
      if (!signal.aborted) updateFailure(sessionId, current, { transferred: true });
    } catch (error) {
      if (!signal.aborted) { updateFailure(sessionId, current, { error: error.code ?? 'SESSION_NAVIGATION_FAILED' }); void refresh(sessionId); }
    } finally { updateFailure(sessionId, current, { navigating: false }); }
  }
  async function execute(command) {
    const controller = new AbortController();
    activeCommand = { requestId: command.requestId, controller };
    const signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(58000)]);
    let ok = false, code;
    try {
      if (command.kind === 'select') await select(command.sessionId, signal, command.draft);
      else if (command.kind === 'goto') await go(command.instanceId, command.sessionId, signal, command.draft);
      else throw fail('SESSION_HOST_INVALID_INPUT');
      ok = !signal.aborted;
    } catch (error) { code = error.code; }
    try { await api('view/ack', { viewId, requestId: command.requestId, sessionId: command.sessionId, ok, code, draftId: ok ? command.draft?.id : undefined }); } catch {}
    if (activeCommand?.requestId === command.requestId) activeCommand = null;
  }
  let ticks = 0;
  async function tick() {
    if (lifetime.signal.aborted) return;
    try {
      if (registered) {
        const response = await updateView();
        if (snapshot.host && response.host.instanceId !== snapshot.host.instanceId) throw fail('SESSION_HOST_CHANGED');
        publish({ host: response.host });
        if (activeCommand && response.command?.requestId !== activeCommand.requestId) activeCommand.controller.abort();
        if (response.command && !commandIds.has(response.command.requestId)) {
          commandIds.add(response.command.requestId);
          if (commandIds.size > 256) commandIds.delete(commandIds.values().next().value);
          void execute(response.command);
        }
      }
      if (ticks++ % 3 === 0) {
        for (const id of Object.keys(snapshot.failures)) if (!snapshot.failures[id].navigating) await refresh(id);
      }
    } catch { /* Registration failure never disables normal sessions or sending. */ }
    if (!lifetime.signal.aborted) timer = setTimeout(tick, 1000);
  }
  void tick();
  return {
    failed, dismiss, refresh, navigate, currentSession,
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async context() { if (!snapshot.host) await status([]); return { windowId, instanceId: snapshot.host.instanceId }; },
    dispose() {
      lifetime.abort(); navigation?.abort(); activeCommand?.controller.abort(); clearTimeout(timer); offPanel(); listeners.clear(); received.clear();
      snapshot = { host: null, failures: {}, incoming: {} };
      if (registered) void window.fetch('/api/workspace-session-hosts/view/remove', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewId }), keepalive: true }).catch(() => {});
    },
  };
}
