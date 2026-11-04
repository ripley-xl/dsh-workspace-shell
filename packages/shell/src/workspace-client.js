// Window-owned composition. Public snapshots never contain view URLs or handles.
//
// The client owns several private maps: provider tabs (Guest/TUI resources), SSH tab
// provenance (connection id/name and status, never the remote URL), launcher provenance
// (source tab identity), and Web measurements. A launcher is metadata-only; converting it
// calls controller.replace so the tab keeps its ID, position, and active state while
// receiving a fresh identity object that invalidates every earlier callback.
export function createWorkspaceClient(deps) {
  const { window, document, ctx, createTabState, createTabController, installInputGate, createDesktopGuest, createTuiProvider } = deps;
  const createBrowserGuest = typeof deps.createBrowserGuest === 'function' ? deps.createBrowserGuest : null;
  const inertTiming = Object.freeze({
    getSnapshot: () => Object.freeze({ entries: Object.freeze([]) }),
    subscribe: () => () => {}, begin: () => Object.freeze({ mark: () => false, finish: () => false, fail: () => false, done: true }),
    invalidate: () => false, clear: () => {}, dispose: () => {},
  });
  const timing = typeof deps.createWebTiming === 'function'
    ? deps.createWebTiming({ limit: 8, ...(typeof deps.now === 'function' ? { now: deps.now } : {}) })
    : inertTiming;
  const fetcher = deps.fetch ?? window.fetch.bind(window);
  const error = (code) => Object.assign(new Error(code), { code });
  const codeOf = (value) => {
    let code;
    try { code = typeof value === 'string' ? value : value?.code; } catch {}
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(code ?? '') ? code : 'WORKSPACE_REQUEST_FAILED';
  };
  const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  let fallbackSequence = 0;
  const uuid = () => {
    try {
      const value = window.crypto?.randomUUID?.();
      if (typeof value === 'string' && value) return value;
    } catch { /* Fall back to a monotonic identifier. */ }
    return 'id-' + (++fallbackSequence);
  };
  const listeners = new Set();
  const connectionListeners = new Set();
  const extensionListeners = new Set();
  let sshRegistration = null;
  const sshExtension = Object.freeze({
    getSnapshot: () => sshRegistration?.extension ?? null,
    subscribe(listener) { extensionListeners.add(listener); return () => extensionListeners.delete(listener); },
  });
  let infoValue = Object.freeze({ phase: 'loading', currentProfile: '', defaultCwd: '', profiles: [], runtimes: [] });
  let sshConnections = Object.freeze([]);
  let disposed = false, disposal, navigation = 0, refreshGeneration = 0, wantedLocal = true;
  let overlayOpen = false;
  const refreshAbort = new AbortController();
  const providers = new Map();
  const tabProviders = new Map();
  const terminalCwds = new Map();
  const webCwdReaders = new Map();
  const webRuntimeIds = new Map();
  const sessionTabTokens = new Map();
  let sessionNavigation = null;
  const sessionNavigationListeners = new Set();
  const sessionNavigationExtension = Object.freeze({
    getSnapshot: () => sessionNavigation,
    subscribe(fn) { sessionNavigationListeners.add(fn); return () => sessionNavigationListeners.delete(fn); },
  });
  function registerSessionNavigation(extension) {
    if (sessionNavigation) throw error('SESSION_NAVIGATION_REGISTERED');
    sessionNavigation = extension;
    for (const fn of sessionNavigationListeners) fn();
    return () => { if (sessionNavigation !== extension) return; sessionNavigation = null; for (const fn of sessionNavigationListeners) fn(); };
  }
  const sessionTabs = () => tabs.getSnapshot().tabs.flatMap((tab) => {
    const token = sessionTabTokens.get(tab.key);
    return token ? [{ id: tab.id, identity: tab.identity, token }] : [];
  });
  const ownedTerminals = new Set();
  const launchers = new Map();
  const timings = new Map();
  const sshTabs = new Map();
  const sshSpecs = new Map();
  // Last measured SSH round trips, used only to seed timing stage offsets. Durations
  // are numbers; host ids never leave this private map.
  const sshMetrics = new Map();
  let sshSequence = 0;
  let launcherSequence = 0;
  let instanceSequence = 0;
  const tabs = createTabController(createTabState({ localTitle: '本地' }), {
    onExit(id) {
      void close(id).catch((cause) => { if (!disposed) publish({ ...infoValue, errorCode: codeOf(cause) }); });
    },
  });
  const gate = installInputGate(ctx.get?.('shortcuts') ?? ctx.shortcuts);
  const bridge = window.dshDesktop?.browser;
  const desktopUsable = ['acquire', 'release', 'onOpenRequested'].every((key) => typeof bridge?.[key] === 'function');
  const browserUsable = typeof createBrowserGuest === 'function';
  const canWeb = gate.supported && (desktopUsable || browserUsable);
  const canTui = gate.supported;
  let ownerId;
  try { ownerId = window.sessionStorage.getItem('workspace-shell.owner.v1'); } catch {}
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ownerId ?? '')) {
    ownerId = 'window-' + uuid();
    try { window.sessionStorage.setItem('workspace-shell.owner.v1', ownerId); } catch {}
  }
  const publish = (value) => {
    infoValue = Object.freeze(value);
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  };
  const publishConnections = (value) => {
    sshConnections = Object.freeze(value);
    for (const listener of [...connectionListeners]) { try { listener(); } catch {} }
  };
  const info = Object.freeze({ getSnapshot: () => infoValue, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } });
  const connections = Object.freeze({
    getSnapshot: () => sshConnections,
    subscribe: (listener) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener); },
  });
  async function api(path, input = {}, signal) {
    let response, value;
    try {
      response = await fetcher('/api/workspace-shell' + path, { method: 'POST', credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
      value = await response.json();
    } catch (cause) { throw error(signal?.aborted ? 'OPERATION_CANCELLED' : 'WORKSPACE_UNREACHABLE'); }
    if (!response.ok || value?.ok !== true) throw error(codeOf(value?.error));
    if (path === '/tui/open' && typeof value.result?.runtimeId === 'string') { ownedTerminals.add(value.result.runtimeId); void refresh(); }
    if (path === '/runtime/stop') ownedTerminals.delete(input.runtimeId);
    return value.result;
  }
  const viewCounts = () => {
    const counts = new Map();
    const live = tabs.getSnapshot().tabs;
    for (const [key, runtimeId] of webRuntimeIds) {
      if (live.some((tab) => tab.kind === 'profile-ui' && tab.key === key)) counts.set(runtimeId, (counts.get(runtimeId) ?? 0) + 1);
    }
    return counts;
  };
  const withViews = (runtimes) => {
    const counts = viewCounts();
    return Object.freeze(runtimes.map((runtime) => Object.freeze({
      ...runtime, source: runtime.source === 'ssh' ? 'ssh' : 'local', views: counts.get(runtime.id) ?? 0,
    })));
  };
  // Refresh private view counts without a round trip; the Host list stays truthful.
  const syncViews = () => {
    if (disposed || infoValue.phase !== 'ready') return;
    const counts = viewCounts();
    if (!infoValue.runtimes.some((runtime) => runtime.views !== (counts.get(runtime.id) ?? 0))) return;
    publish({ ...infoValue, runtimes: withViews(infoValue.runtimes) });
  };
  const mapProfile = (item) => Object.freeze({
    id: item.id, isCurrent: item.isCurrent === true, web: item.web === true, tui: item.tui === true,
    ...['dsh-tui', 'pi-tui', 'generic-tui'].includes(item.tuiFlavor) ? { tuiFlavor: item.tuiFlavor } : {},
  });
  const mapRuntime = (item) => Object.freeze({
    id: item.id, kind: item.kind, profileId: item.profileId, phase: item.phase, canStop: item.canStop === true,
    ...(item.source === 'ssh' ? { source: 'ssh' } : {}),
  });
  async function refresh() {
    if (disposed) return false;
    const generation = ++refreshGeneration;
    try {
      const result = await api('/catalog', { ownerId }, refreshAbort.signal);
      if (disposed || generation !== refreshGeneration) return false;
      if (typeof result?.currentProfile !== 'string' || !Array.isArray(result.profiles) || !Array.isArray(result.runtimes)) throw error('WORKSPACE_INVALID_CATALOG');
      const profiles = result.profiles.slice(0, 256).filter((item) => typeof item?.id === 'string').map(mapProfile);
      const runtimes = withViews(result.runtimes.slice(0, 128).filter((item) => typeof item?.id === 'string').map(mapRuntime));
      publish({ phase: 'ready', currentProfile: result.currentProfile, defaultCwd: typeof result.defaultCwd === 'string' ? result.defaultCwd : '', profiles: Object.freeze(profiles), runtimes });
      return true;
    } catch (cause) {
      // Keep the previous list and mark it possibly stale instead of pretending it is empty.
      if (!disposed && generation === refreshGeneration) publish({ ...infoValue, phase: 'error', errorCode: codeOf(cause) });
      return false;
    }
  }
  async function activate(id) {
    if (disposed || !tabs.getSnapshot().tabs.some((tab) => tab.id === id)) return false;
    if (id !== 'local' && deps.isFrameActive && !deps.isFrameActive()) return false;
    const ticket = ++navigation;
    if (gate.supported ? !await gate.setLocal(id === 'local' && !overlayOpen) : id !== 'local') return false;
    if (disposed || ticket !== navigation) return false;
    if (!tabs.getSnapshot().tabs.some((tab) => tab.id === id)) {
      wantedLocal = tabs.getSnapshot().activeId === 'local';
      await gate.setLocal(wantedLocal && !overlayOpen);
      return false;
    }
    wantedLocal = id === 'local';
    return tabs.activate(id);
  }
  async function setOverlay(value) {
    if (disposed) return false;
    if (overlayOpen === (value === true)) return true;
    overlayOpen = value === true;
    const ticket = ++navigation;
    const ok = !gate.supported || await gate.setLocal(tabs.getSnapshot().activeId === 'local' && !overlayOpen);
    if (!ok && !disposed && ticket === navigation) publish({ ...infoValue, errorCode: 'WORKSPACE_INPUT_GATE_FAILED' });
    return ok && !disposed && ticket === navigation;
  }
  const forget = (id) => {
    const tab = tabs.getSnapshot().tabs.find((item) => item.id === id);
    if (tab) sshSpecs.delete(tab.key);
    tabProviders.delete(id);
    launchers.delete(id);
    sshTabs.delete(id);
  };
  async function close(id) {
    if (disposed || id === 'local') return false;
    if (tabs.getSnapshot().activeId === id && !await activate('local')) throw error('WORKSPACE_INPUT_GATE_FAILED');
    const result = await tabs.close(id);
    forget(id);
    void refresh();
    return result;
  }
  async function closeViews() {
    if (disposed) return;
    if (!await activate('local')) throw error('WORKSPACE_INPUT_GATE_FAILED');
    await Promise.all(tabs.getSnapshot().tabs.filter((tab) => tab.closable).map((tab) => close(tab.id)));
  }
  const offTabs = tabs.subscribe(() => {
    const snapshot = tabs.getSnapshot();
    for (const id of tabProviders.keys()) if (!snapshot.tabs.some((tab) => tab.id === id)) tabProviders.delete(id);
    for (const id of launchers.keys()) if (!snapshot.tabs.some((tab) => tab.id === id)) launchers.delete(id);
    for (const id of sshTabs.keys()) if (!snapshot.tabs.some((tab) => tab.id === id)) sshTabs.delete(id);
    for (const key of sshSpecs.keys()) if (!snapshot.tabs.some((tab) => tab.key === key)) sshSpecs.delete(key);
    for (const key of terminalCwds.keys()) if (!snapshot.tabs.some((tab) => tab.key === key)) terminalCwds.delete(key);
    for (const key of webCwdReaders.keys()) if (!snapshot.tabs.some((tab) => tab.key === key)) webCwdReaders.delete(key);
    for (const key of webRuntimeIds.keys()) if (!snapshot.tabs.some((tab) => tab.key === key)) webRuntimeIds.delete(key);
    syncViews();
    // A surface unmount/error boundary can close outside the normal toolbar path.
    if (!disposed && snapshot.activeId === 'local' && !wantedLocal) {
      wantedLocal = true; const restore = ++navigation;
      void gate.setLocal(!overlayOpen).then((ok) => { if (!ok && !disposed && restore === navigation) publish({ ...infoValue, errorCode: 'WORKSPACE_INPUT_GATE_FAILED' }); });
    }
  });
  for (const kind of ['profile-ui', 'terminal', 'browser']) tabs.registerProvider(kind, { open(spec, options) {
    const provider = providers.get(spec.providerId);
    if (!provider || provider.kind !== kind) throw error('TAB_PROVIDER_UNAVAILABLE');
    return provider.open(spec, options);
  } });
  function registerProvider(id, provider) {
    if (disposed) throw error('WORKSPACE_DISPOSED');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !['profile-ui', 'terminal', 'browser'].includes(provider?.kind) || typeof provider.open !== 'function') throw error('WORKSPACE_INVALID_PROVIDER');
    if (providers.has(id)) throw error('TAB_PROVIDER_REGISTERED');
    providers.set(id, provider);
    let removal;
    return () => {
      if (removal) return removal;
      if (providers.get(id) === provider) providers.delete(id);
      removal = Promise.all(tabs.getSnapshot().tabs.filter((tab) => tab.key.startsWith(id + ':')).map((tab) => tabs.close(tab.id)));
      removal.catch(() => {});
      return removal;
    };
  }
  async function open(spec) {
    if (deps.isFrameActive && !deps.isFrameActive()) throw error('WORKSPACE_FRAME_INACTIVE');
    if (disposed) throw error('WORKSPACE_DISPOSED');
    const provider = providers.get(spec?.providerId);
    if (!provider) throw error('TAB_PROVIDER_UNAVAILABLE');
    // SSH views carry an already-authorized loopback URL; the Host list's attach path
    // carries a runtimeId. Neither may be combined into a profile-name lookup.
    const merged = { ...spec, kind: provider.kind, key: spec.providerId + ':' + spec.key };
    if (!merged.sessionHost && !merged.runtimeId && !merged.url && spec.providerId === 'local-web' && infoValue.phase === 'ready' && spec.profileId === infoValue.currentProfile) {
      await activate('local'); return 'local';
    }
    const token = tokenFor(merged.key, { source: spec.ssh ? 'ssh' : 'local', profile: spec.profileId, reused: merged.runtimeId !== undefined || typeof merged.url === 'string' });
    const ticket = ++navigation;
    if (!await gate.setLocal(false) || disposed || ticket !== navigation) {
      token?.fail('WORKSPACE_INPUT_GATE_FAILED');
      throw error('WORKSPACE_INPUT_GATE_FAILED');
    }
    // The input stage measures how long the Local-to-view input switch took.
    token?.mark('input');
    if (providers.get(spec.providerId) !== provider) {
      if (tabs.getSnapshot().activeId === 'local') await gate.setLocal(!overlayOpen);
      token?.fail('TAB_PROVIDER_UNAVAILABLE');
      throw error('TAB_PROVIDER_UNAVAILABLE');
    }
    wantedLocal = false;
    let id;
    try { id = tabs.open(merged); }
    catch (cause) {
      token?.fail(codeOf(cause));
      if (tabs.getSnapshot().activeId === 'local') { wantedLocal = true; await gate.setLocal(!overlayOpen); }
      throw cause;
    }
    // A provider revoked inside the synchronous reserve notification returns null here;
    // the placeholder was already closed and no resource was acquired.
    if (!id) { token?.fail('OPERATION_CANCELLED'); return null; }
    tabProviders.set(id, spec.providerId);
    return id;
  }
  // One monotonic clock feeds both the measurement store and the SSH offsets so
  // mixed stages line up; tests can inject it.
  const timingNow = () => {
    if (typeof deps.now === 'function') return deps.now();
    try { if (typeof window.performance?.now === 'function') return window.performance.now(); } catch { /* Fall back to wall time. */ }
    return Date.now();
  };
  const parentOrigin = (() => {
    try { const origin = window.location?.origin; if (typeof origin === 'string' && /^https?:\/\/[^\s/?#@]{1,255}$/.test(origin)) return origin; } catch {}
    return undefined;
  })();
  function createGuest(options) {
    if (desktopUsable) return createDesktopGuest({ ...options, bridge, parentOrigin });
    if (browserUsable) return createBrowserGuest({ ...options, parentOrigin });
    throw error('WORKSPACE_GUEST_UNAVAILABLE');
  }
  const webUrl = (value) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port) throw error('WORKSPACE_INVALID_WEB_URL');
    url.searchParams.set('workspaceShellEmbedded', '1');
    return url;
  };
  const tokenFor = (key, meta) => {
    if (timing === inertTiming) return null;
    const existing = timings.get(key);
    if (existing) return existing;
    try {
      const token = timing.begin({ key, kind: 'web', ...meta });
      timings.set(key, token);
      return token;
    } catch { return null; }
  };
  function webView(spec, options) {
    let guest, shown = true, closed = false, closing, readyTimer;
    const registration = spec.ssh ? sshRegistration : null;
    const abort = new AbortController();
    const token = tokenFor(spec.key, { source: spec.ssh ? 'ssh' : 'local', profile: spec.profileId, reused: spec.runtimeId !== undefined || typeof spec.url === 'string' });
    const report = (cause) => {
      const code = codeOf(cause);
      token?.fail(code);
      if (!closed) options.onError({ code });
    };
    webCwdReaders.set(spec.key, () => closed ? null : guest?.getWorkingDirectory?.() ?? null);
    const resolveUrl = async () => {
      if (spec.sessionHost) {
        const response = await fetcher('/api/workspace-session-hosts/attach', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec.sessionHost), signal: abort.signal });
        const value = await response.json();
        if (!response.ok || !value.ok || value.result?.host?.instanceId !== spec.sessionHost.instanceId || value.result?.sessionId !== spec.sessionHost.sessionId) throw error('SESSION_HOST_CHANGED');
        return webUrl(value.result.url);
      }
      if (spec.ssh) {
        if (!sshRegistration) throw error('SSH_COMPONENT_DISABLED');
        if (spec.remote?.url && spec.remote.registration === registration) return webUrl(spec.remote.url);
        if (!spec.instanceId) throw error('REMOTE_INSTANCE_UNAVAILABLE');
        const attached = await sshRequest('/web/attach', { body: { hostId: spec.hostId, instanceId: spec.instanceId }, signal: abort.signal });
        if (attached.instanceId !== spec.instanceId) throw error('REMOTE_INSTANCE_UNAVAILABLE');
        return webUrl(attached.url);
      }
      if (typeof spec.url === 'string') return webUrl(spec.url);
      if (typeof spec.runtimeId === 'string') {
        const result = await api('/web/attach', { runtimeId: spec.runtimeId, ownerId }, abort.signal);
        if (typeof result?.runtimeId === 'string') { webRuntimeIds.set(spec.key, result.runtimeId); syncViews(); }
        return webUrl(result?.url);
      }
      const result = await api('/web/open', { profileId: spec.profileId, ownerId, confirmIndependentHost: spec.confirmIndependentHost === true }, abort.signal);
      if (typeof result?.runtimeId === 'string') { webRuntimeIds.set(spec.key, result.runtimeId); syncViews(); }
      return webUrl(result?.url);
    };
    const task = resolveUrl().then(async (url) => {
      if (closed) return;
      if (spec.ssh && sshRegistration !== registration) throw error('SSH_COMPONENT_DISABLED');
      if (!spec.ssh && sessionNavigation?.context) {
        const parent = await sessionNavigation.context();
        if (closed) return;
        const token = window.crypto.randomUUID().replaceAll('-', '');
        sessionTabTokens.set(spec.key, token);
        url.searchParams.set('workspaceSessionWindow', parent.windowId);
        url.searchParams.set('workspaceSessionParent', parent.instanceId);
        url.searchParams.set('workspaceSessionTab', token);
        // Connection's login redirect removes the query but preserves the fragment.
        const bootstrap = new URLSearchParams({ workspaceShellEmbedded: '1', workspaceSessionWindow: parent.windowId, workspaceSessionParent: parent.instanceId, workspaceSessionTab: token });
        url.hash = url.hash.slice(1) + (url.hash ? '&' : '') + bootstrap.toString();
      }
      token?.mark('host');
      guest = createGuest({ document, window, container: options.container, workspaceKey: 'workspace-profile:' + spec.key, url: url.href, signal: abort.signal,
        onReady() {
          window.clearTimeout(readyTimer);
          if (closed) return;
          token?.mark('load');
          token?.finish();
          options.onReady();
          void refresh();
        },
        onError: report, openExternal: (target) => { if (!closed) window.open(target, '_blank', 'noopener,noreferrer'); } });
      guest.setVisible(shown);
      readyTimer = window.setTimeout(() => report(error('WORKSPACE_VIEW_TIMEOUT')), 30000);
      await guest.start();
      token?.mark('lease');
    }).catch(report);
    const dispose = () => {
      if (closing) return closing;
      closed = true; abort.abort(); window.clearTimeout(readyTimer);
      sessionTabTokens.delete(spec.key);
      // A cancelled open is not a measurement: retire it without publishing.
      timings.delete(spec.key);
      if (token) { try { timing.invalidate(spec.key); } catch { /* Timing cleanup never blocks the view. */ } }
      options.signal?.removeEventListener('abort', dispose);
      closing = Promise.resolve().then(async () => { await guest?.dispose(); await task; await guest?.dispose(); });
      closing.catch(() => {});
      return closing;
    };
    options.signal?.addEventListener('abort', dispose, { once: true });
    if (options.signal?.aborted) void dispose();
    return { dispose, setVisible(value) { shown = value === true; guest?.setVisible(shown); }, focus() { if (!closed && shown) guest?.focus(); }, resize() { guest?.resize(); } };
  }
  if (canWeb) {
    registerProvider('local-web', { kind: 'profile-ui', open: webView });
    registerProvider('ssh-web', { kind: 'profile-ui', open: webView });
  }
  if (canTui) {
    const activeLocale = ctx.locale?.getSnapshot?.().active || document.documentElement.lang || 'zh';
    registerProvider('local-tui', { kind: 'terminal', ...createTuiProvider({ document, window, api, ownerId, locale: String(activeLocale).toLowerCase().startsWith('zh') ? 'zh' : 'en' }) });
  }
  const requireCatalog = (profileId, kind) => {
    if (infoValue.phase !== 'ready') throw error('WORKSPACE_CATALOG_NOT_READY');
    const profile = infoValue.profiles.find((item) => item.id === profileId);
    if (!profile || (kind === 'tui' ? !profile.tui : !profile.web) && !profile.isCurrent) throw error('PROFILE_NOT_FOUND');
    return profile;
  };
  const pagehide = () => {
    if (!ownedTerminals.size) return;
    // Best effort on document loss; Host disposal is the final process owner.
    try { Promise.resolve(fetcher('/api/workspace-shell/runtime/close-owner', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId, runtimeIds: [...ownedTerminals] }), keepalive: true })).catch(() => {}); } catch {}
  };
  window.addEventListener('pagehide', pagehide);
  void refresh();

  // ---- Launcher ----------------------------------------------------------------
  async function openLauncher() {
    if (deps.isFrameActive && !deps.isFrameActive()) throw error('WORKSPACE_FRAME_INACTIVE');
    if (disposed) throw error('WORKSPACE_DISPOSED');
    const ticket = ++navigation;
    if (!await gate.setLocal(false) || disposed || ticket !== navigation) throw error('WORKSPACE_INPUT_GATE_FAILED');
    wantedLocal = false;
    const snapshot = tabs.getSnapshot();
    const source = snapshot.tabs.find((tab) => tab.id === snapshot.activeId) ?? null;
    const key = `launcher:${++launcherSequence}:${uuid()}`;
    let id;
    try { id = tabs.open({ kind: 'launcher', key, title: '新建工作区' }); }
    catch (cause) {
      if (tabs.getSnapshot().activeId === 'local') { wantedLocal = true; await gate.setLocal(!overlayOpen); }
      throw cause;
    }
    if (!id) throw error('TAB_OPEN_FAILED');
    const record = tabs.getSnapshot().tabs.find((tab) => tab.id === id);
    if (!record) throw error('TAB_OPEN_FAILED');
    launchers.set(id, {
      identity: record.identity,
      source: source ? { tabId: source.id, tabKey: source.key, kind: source.kind, identity: source.identity } : null,
    });
    return id;
  }
  function liveLauncher(id) {
    const record = launchers.get(id);
    if (disposed || !record) return null;
    const tab = tabs.getSnapshot().tabs.find((item) => item.id === id);
    if (!tab || tab.kind !== 'launcher' || tab.identity !== record.identity) return null;
    return record;
  }
  function launcherSource(id) {
    const record = launchers.get(id);
    return record?.source ? Object.freeze({ kind: record.source.kind, tabId: record.source.tabId }) : null;
  }
  async function readLauncherCwd(id, localCwd) {
    const record = liveLauncher(id);
    if (!record?.source) return null;
    const source = record.source;
    const current = () => {
      const snapshot = tabs.getSnapshot();
      const launcher = snapshot.tabs.find((tab) => tab.id === id);
      if (disposed || !launcher || launcher.kind !== 'launcher' || launcher.identity !== record.identity) return false;
      const tab = snapshot.tabs.find((item) => item.id === source.tabId);
      return !!tab && tab.identity === source.identity && tab.key === source.tabKey;
    };
    if (!current()) return null;
    let value;
    if (source.kind === 'local' || source.tabId === 'local') value = localCwd;
    else if (source.kind === 'terminal') value = terminalCwds.get(source.tabKey);
    else if (source.kind === 'profile-ui') {
      const read = webCwdReaders.get(source.tabKey);
      if (!read) return null;
      try { value = await read(); } catch { return null; }
      if (!current()) return null;
    } else return null;
    return typeof value === 'string' && value.trim() ? value : null;
  }
  async function replaceLauncher(id, spec, context = {}) {
    if (deps.isFrameActive && !deps.isFrameActive()) throw error('WORKSPACE_FRAME_INACTIVE');
    const record = liveLauncher(id);
    if (!record) throw error('WORKSPACE_LAUNCHER_STALE');
    const provider = providers.get(spec.providerId);
    if (!provider) throw error('TAB_PROVIDER_UNAVAILABLE');
    const key = spec.providerId + ':' + spec.key;
    const token = context.kind === 'web' ? tokenFor(key, { source: spec.ssh ? 'ssh' : 'local', profile: context.profileId, reused: spec.runtimeId !== undefined }) : null;
    try { await tabs.replace(id, { ...spec, kind: provider.kind, key }); }
    catch (cause) { token?.fail(codeOf(cause)); throw cause; }
    const latest = tabs.getSnapshot().tabs.find((tab) => tab.id === id);
    const converted = !!latest && latest.kind === provider.kind && latest.key === key;
    if (!converted) {
      token?.fail('WORKSPACE_OPEN_FAILED');
      throw error('WORKSPACE_OPEN_FAILED');
    }
    launchers.delete(id);
    tabProviders.set(id, spec.providerId);
    if (provider.kind === 'terminal' && typeof spec.cwd === 'string') terminalCwds.set(key, spec.cwd);
    // A provider that failed during acquisition keeps the converted record in a safe
    // error state (retry or close); the conversion itself already preserved ID/position.
    return id;
  }
  async function openLauncherWeb(id, { profileId, runtimeId } = {}) {
    if (typeof profileId !== 'string' || !identifier(profileId)) throw error('PROFILE_NOT_FOUND');
    if (runtimeId !== undefined) {
      if (!identifier(runtimeId)) throw error('RUNTIME_NOT_FOUND');
      const runtime = infoValue.runtimes.find((item) => item.id === runtimeId);
      if (!runtime || runtime.kind !== 'web' || runtime.phase !== 'running' || runtime.canStop !== true || runtime.source === 'ssh') throw error('RUNTIME_NOT_ACTIVE');
    } else requireCatalog(profileId, 'web');
    const sequence = ++instanceSequence;
    return replaceLauncher(id, {
      providerId: 'local-web', key: `${profileId}:web:${sequence}:${uuid()}`,
      title: `${profileId} · Web ${sequence}`, profileId,
      ...(runtimeId === undefined ? { confirmIndependentHost: true } : { runtimeId }),
    }, { profileId, kind: 'web' });
  }
  const flavorLabel = (flavor) => flavor === 'pi-tui' ? 'Pi TUI' : flavor === 'dsh-tui' ? 'DSH TUI' : 'TUI';
  async function openLauncherTui(id, { profileId, cwd, command } = {}) {
    const profile = requireCatalog(profileId, 'tui');
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096 || cwd.includes('\u0000')) throw error('INVALID_TUI_CWD');
    if (command !== undefined && command !== null && (typeof command !== 'string' || command.length > 4096 || /[\0\r\n]/u.test(command))) throw error('INVALID_TUI_COMMAND');
    const sequence = ++instanceSequence;
    return replaceLauncher(id, {
      providerId: 'local-tui', key: `${profileId}:tui:${sequence}:${uuid()}`,
      title: `${profileId} · ${flavorLabel(profile.tuiFlavor)} ${sequence}`,
      profileId, cwd: cwd.trim(), confirmIndependentHost: true,
      ...(typeof command === 'string' && command.trim() ? { command: command.trim() } : {}),
    }, { profileId });
  }
  function moveTab(id, targetIndex) {
    if (disposed) return false;
    try { return tabs.move(id, targetIndex) === true; } catch { return false; }
  }

  // ---- SSH Web -----------------------------------------------------------------
  function registerSshExtension(extension) {
    if (disposed) throw error('WORKSPACE_DISPOSED');
    if (!extension || typeof extension.request !== 'function') throw error('WORKSPACE_INVALID_PROVIDER');
    if (sshRegistration) throw error('TAB_PROVIDER_REGISTERED');
    const registration = { extension, abort: new AbortController() };
    sshRegistration = registration;
    const update = () => {
      if (sshRegistration !== registration || disposed) return;
      const snapshot = extension.getSnapshot?.();
      if (Array.isArray(snapshot?.connections)) {
        mergeConnections(snapshot.connections.map(connectionEntry), true);
      }
    };
    const unsubscribe = extension.subscribe?.(update) ?? (() => {});
    registration.unsubscribe = unsubscribe;
    update();
    for (const listener of [...extensionListeners]) { try { listener(); } catch {} }
    let removal;
    return () => {
      if (removal) return removal;
      unsubscribe();
      if (sshRegistration !== registration) return Promise.resolve();
      sshRegistration = null;
      registration.abort.abort();
      for (const spec of sshSpecs.values()) delete spec.url;
      const owned = tabs.getSnapshot().tabs.filter((tab) => sshSpecs.has(tab.key) || sshTabs.has(tab.id));
      removal = Promise.all(owned.map((tab) => tabs.suspend(tab.id, 'SSH_COMPONENT_DISABLED')));
      publishConnections([]);
      for (const listener of [...extensionListeners]) { try { listener(); } catch {} }
      return removal;
    };
  }
  function mergeConnections(entries, replace = false) {
    const byId = new Map(replace ? [] : sshConnections.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !identifier(entry.id)) continue;
      const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 128 ? entry.name.trim() : byId.get(entry.id)?.name;
      if (!name) continue;
      byId.set(entry.id, Object.freeze({ id: entry.id, name, connected: entry.connected === true }));
    }
    const next = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
    if (next.length === sshConnections.length && next.every((entry, index) => entry === sshConnections[index])) return;
    publishConnections(next);
  }
  const connectionEntry = (entry) => entry && typeof entry === 'object'
    ? { id: entry.id, name: entry.name ?? entry.alias ?? entry.hostAlias, connected: typeof entry.connected === 'boolean' ? entry.connected : ['connected', 'ready', 'switching'].includes(entry.phase) }
    : null;
  function reportSsh(payload) {
    if (disposed || !payload || typeof payload !== 'object') return false;
    try {
      if (Array.isArray(payload.hosts)) mergeConnections(payload.hosts.map(connectionEntry));
      else if (Array.isArray(payload.connections)) mergeConnections(payload.connections.map(connectionEntry));
      else if (typeof payload.id === 'string' || typeof payload.host?.id === 'string') mergeConnections([connectionEntry(payload.host ?? payload)]);
    } catch { /* Status reporting never throws into the SSH component. */ }
    return true;
  }
  async function sshRequest(pathname, options = {}) {
    if (disposed) throw error('WORKSPACE_DISPOSED');
    const registration = sshRegistration;
    if (!registration) throw error('SSH_COMPONENT_DISABLED');
    const body = options.body;
    const started = timingNow();
    const signal = options.signal ? AbortSignal.any([options.signal, registration.abort.signal]) : registration.abort.signal;
    const value = await registration.extension.request(pathname, { ...options, signal });
    if (disposed || sshRegistration !== registration) throw error('SSH_COMPONENT_DISABLED');
    // Only successful round trips contribute an offset; failures never fabricate one.
    const hostId = typeof body?.hostId === 'string' && identifier(body.hostId) ? body.hostId : null;
    if (hostId && (pathname === '/connect' || pathname === '/disconnect')) sshMetrics.set(hostId + ':connect', timingNow() - started);
    if (hostId && pathname === '/web/open') {
      sshMetrics.set(hostId + ':open', timingNow() - started);
    }
    reportSsh(value);
    return value;
  }
  const sshHost = (host) => {
    if (!host || typeof host !== 'object' || typeof host.id !== 'string' || !identifier(host.id)) throw error('SSH_HOST_INVALID');
    const name = typeof host.name === 'string' && host.name.trim() && host.name.length <= 128 ? host.name.trim() : host.id;
    return { id: host.id, name, connected: host.connected === true };
  };
  async function openSshWeb(host, url, meta = {}) {
    const registration = sshRegistration;
    if (!registration) throw error('SSH_COMPONENT_DISABLED');
    const specProfileId = meta && typeof meta.profileId === 'string' && identifier(meta.profileId) ? meta.profileId : '';
    const instanceId = meta && typeof meta.instanceId === 'string' && identifier(meta.instanceId) ? meta.instanceId : '';
    const launcherId = meta && typeof meta.launcherId === 'string' ? meta.launcherId : '';
    if (!canWeb) throw error('WORKSPACE_SSH_UNAVAILABLE');
    if (deps.isFrameActive && !deps.isFrameActive()) throw error('WORKSPACE_FRAME_INACTIVE');
    const target = sshHost(host);
    const parsed = webUrl(url);
    const sequence = ++sshSequence;
    const rawKey = `${target.id}:web:${sequence}:${uuid()}`;
    const key = 'ssh-web:' + rawKey;
    mergeConnections([target]);
    const token = tokenFor(key, { source: 'ssh', profile: specProfileId, reused: true });
    token?.mark('input');
    // SSH measured connect and open round trips are already complete when the tab is
    // created, so they enter as absolute offsets rather than fresh marks.
    const connectMs = sshMetrics.get(target.id + ':connect');
    const openMs = sshMetrics.get(target.id + ':open');
    if (Number.isFinite(connectMs)) token?.stage('connect', connectMs);
    if (Number.isFinite(connectMs) && Number.isFinite(openMs)) token?.stage('instance', connectMs + openMs);
    else if (Number.isFinite(openMs)) token?.stage('instance', openMs);
    const spec = {
      providerId: 'ssh-web', kind: 'profile-ui', key,
      title: `${specProfileId || 'Web'} ${sequence}`,
      ...(specProfileId ? { profileId: specProfileId } : {}),
      remote: { url: parsed.href, registration }, hostId: target.id, hostName: target.name, ssh: true, instanceId,
    };
    let id;
    if (launcherId) {
      id = await replaceLauncher(launcherId, spec, { profileId: specProfileId, kind: 'web' });
    } else {
      const ticket = ++navigation;
      if (!await gate.setLocal(false) || disposed || ticket !== navigation) throw error('WORKSPACE_INPUT_GATE_FAILED');
      if (sshRegistration !== registration) {
        if (tabs.getSnapshot().activeId === 'local') await gate.setLocal(!overlayOpen);
        throw error('SSH_COMPONENT_DISABLED');
      }
      wantedLocal = false;
      try { id = tabs.open(spec); }
      catch (cause) {
        token?.fail(codeOf(cause));
        if (tabs.getSnapshot().activeId === 'local') { wantedLocal = true; await gate.setLocal(!overlayOpen); }
        throw cause;
      }
      if (id) tabProviders.set(id, 'ssh-web');
    }
    if (!id) { token?.fail('TAB_OPEN_FAILED'); throw error('TAB_OPEN_FAILED'); }
    sshTabs.set(id, Object.freeze({ hostId: target.id, name: target.name, profileId: specProfileId, instanceId }));
    const openedTab = tabs.getSnapshot().tabs.find((tab) => tab.id === id);
    if (openedTab) sshSpecs.set(openedTab.key, spec.remote);
    if (sshRegistration !== registration) {
      delete spec.remote.url;
      await tabs.suspend(id, 'SSH_COMPONENT_DISABLED');
    }
    token?.mark('host');
    return id;
  }
  // SSH panels show how many views of this window hold a Host for `hostId:profileId`.
  function sshViewCounts() {
    const counts = {};
    const live = tabs.getSnapshot().tabs;
    for (const [id, source] of sshTabs) {
      if (!source.profileId) continue;
      if (!live.some((tab) => tab.id === id && tab.kind === 'profile-ui')) continue;
      const key = source.hostId + ':' + source.profileId;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
  function getTabStatus(tab) {
    const source = sshTabs.get(tab?.id);
    if (!source) return null;
    const connection = sshConnections.find((entry) => entry.id === source.hostId);
    const name = connection?.name ?? source.name;
    // `source` and `alias` are the Chrome strip contract; `name`/`label` stay for
    // other consumers. No remote URL ever enters this snapshot.
    return Object.freeze({
      source: 'ssh', alias: name, name,
      connected: !!sshRegistration && connection?.connected === true,
      label: `${name} · ${tab.title}`,
    });
  }
  async function closeSshViews(hostId, instanceId) {
    if (disposed) return 0;
    const ids = [...sshTabs].filter(([, source]) => source.hostId === hostId && (!instanceId || source.instanceId === instanceId)).map(([id]) => id);
    let closed = 0;
    for (const id of ids) { try { if (await close(id)) closed += 1; } catch { /* Keep closing the remaining views. */ } }
    return closed;
  }
  async function stopRuntime(id) {
    const runtime = infoValue.runtimes.find((item) => item.id === id);
    const knownKeys = new Set([...webRuntimeIds].filter(([, runtimeId]) => runtimeId === id).map(([key]) => key));
    await api('/runtime/stop', { runtimeId: id, ownerId });
    try {
      if (runtime?.kind !== 'web' && !knownKeys.size) return;
      const views = tabs.getSnapshot().tabs.filter((tab) => tab.id !== 'local' && tab.kind === 'profile-ui'
        && tabProviders.get(tab.id) === 'local-web' && (knownKeys.has(tab.key) || tab.profileId === runtime?.profileId));
      for (const view of views) await close(view.id);
    } finally {
      await refresh();
    }
  }
  async function readDefaultCwd(tabId, localCwd) {
    const snapshot = tabs.getSnapshot();
    const source = snapshot.tabs.find((tab) => tab.id === tabId);
    if (disposed || !source || snapshot.activeId !== tabId) return null;
    const isCurrent = () => {
      const latest = tabs.getSnapshot();
      const tab = latest.tabs.find((item) => item.id === tabId);
      return !disposed && latest.activeId === tabId && tab?.key === source.key && tab.identity === source.identity;
    };
    let value;
    if (source.id === 'local') value = localCwd;
    else if (source.kind === 'terminal') value = terminalCwds.get(source.key);
    else if (source.kind === 'profile-ui') {
      const read = webCwdReaders.get(source.key);
      if (!read) return null;
      try { value = await read(); } catch { return null; }
    } else return null;
    if (!isCurrent() || typeof value !== 'string' || !value.trim()) return null;
    return value;
  }
  const openWeb = (profileId, confirmed = false) => {
    requireCatalog(profileId, 'web');
    if (profileId === infoValue.currentProfile) return activate('local').then(() => 'local');
    const sequence = ++instanceSequence;
    return open({ providerId: 'local-web', key: `${profileId}:web:${sequence}:${uuid()}`, title: `${profileId} · Web ${sequence}`, profileId, confirmIndependentHost: confirmed });
  };
  const openSessionHost = ({ instanceId, sessionId, profile }) => {
    if (!/^[a-f0-9]{32}$/.test(instanceId) || !identifier(sessionId) || !identifier(profile)) throw error('SESSION_HOST_INVALID_INPUT');
    return open({ providerId: 'local-web', key: `session:${uuid()}`, title: `${profile} · Web`, sessionHost: { instanceId, sessionId } });
  };
  const openTui = (profileId, cwd, confirmed = false, options = {}) => {
    const profile = requireCatalog(profileId, 'tui');
    const sequence = ++instanceSequence;
    const key = `${profileId}:tui:${sequence}:${uuid()}`;
    const command = typeof options?.command === 'string' && options.command.trim() ? options.command.trim() : undefined;
    return open({ providerId: 'local-tui', key, title: `${profileId} · ${flavorLabel(profile.tuiFlavor)} ${sequence}`, profileId, cwd, confirmIndependentHost: confirmed, ...(command ? { command } : {}) }).then((id) => {
      const tab = tabs.getSnapshot().tabs.find((item) => item.id === id);
      if (id && typeof cwd === 'string' && tab?.kind === 'terminal') terminalCwds.set(tab.key, cwd);
      return id;
    });
  };
  return Object.freeze({ tabs, info, connections, sshExtension, registerSshExtension, sessionNavigationExtension, registerSessionNavigation, sessionTabs, openSessionHost, timing, canWeb, canTui, refresh, registerProvider, open, activate, setOverlay, close, closeViews, readDefaultCwd,
    openLauncher, launcherSource, readLauncherCwd, openLauncherWeb, openLauncherTui, moveTab,
    openWeb, openTui, getTabStatus, sshRequest, reportSsh, openSshWeb, closeSshViews, sshViewCounts,
    async retry(id) {
      if (disposed) return false;
      if (sshTabs.has(id) && !sshRegistration) throw error('SSH_COMPONENT_DISABLED');
      if (!await activate(id)) return false;
      return tabs.retry(id);
    },
    stopRuntime,
    dispose() {
      if (disposal) return disposal;
      disposed = true; ++navigation; ++refreshGeneration; refreshAbort.abort();
      sessionTabTokens.clear(); sessionNavigation = null; sessionNavigationListeners.clear();
      sshRegistration?.unsubscribe?.(); sshRegistration?.abort.abort(); sshRegistration = null; extensionListeners.clear(); sshSpecs.clear();
      window.removeEventListener('pagehide', pagehide); offTabs(); listeners.clear(); connectionListeners.clear();
      for (const [key] of timings) { try { timing.invalidate(key); } catch {} }
      timings.clear(); launchers.clear(); sshTabs.clear(); sshMetrics.clear(); sshConnections = Object.freeze([]);
      try { timing.dispose(); } catch {}
      disposal = Promise.resolve().then(async () => { await tabs.dispose(); providers.clear(); tabProviders.clear(); terminalCwds.clear(); webCwdReaders.clear(); webRuntimeIds.clear(); await gate.dispose(); });
      disposal.catch(() => {}); return disposal;
    },
  });
}
