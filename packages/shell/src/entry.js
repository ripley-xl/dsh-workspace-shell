export function createWorkspaceSelection(React, slots) {
  const key = 'conversation.hero.workspace';
  const core = slots?._core;
  const listeners = new Set();
  let snapshot = null;
  let binding;
  let stopped = false;
  const publish = (value) => {
    if (snapshot === value) return;
    snapshot = value;
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  };
  const compatible = typeof core?.records?.get === 'function'
    && typeof core?.markDirty === 'function' && typeof core?.isLive === 'function'
    && typeof slots?.entriesOfSlot === 'function' && typeof slots?.subscribe === 'function';
  const release = () => {
    const current = binding;
    binding = undefined;
    if (!current) return;
    if (current.entry.component === current.view) {
      current.entry.component = current.original;
      if (core.isLive(current.entry)) core.markDirty(key, core.records.get(key));
    }
    publish(null);
  };
  const reconcile = () => {
    if (stopped || !compatible) return;
    const record = core.records.get(key);
    if (record?.spec?.kind !== 'single' || record.spec.scope !== 'root') { release(); return; }
    const entry = slots.entriesOfSlot(key)[0];
    if (binding?.entry === entry && entry?.component === binding.view) return;
    if (binding?.entry === entry && entry && entry.component !== binding.view) { release(); return; }
    release();
    if (!entry || !core.isLive(entry) || slots.entriesOfSlot(key)[0] !== entry) return;
    const original = entry.component;
    if (typeof original !== 'function' || Object.getOwnPropertyDescriptor(entry, 'component')?.writable !== true) return;
    const token = {};
    function ObservedWorkspace(props) {
      const selected = props.useWorkspaces((state) => {
        if (typeof props.selectedId !== 'string') return null;
        const workspace = (Array.isArray(state?.items) ? state.items : []).find((item) => item.workspaceId === props.selectedId);
        return typeof workspace?.path === 'string' && workspace.path.trim() ? workspace.path : null;
      });
      React.useLayoutEffect(() => { if (binding?.token === token) publish(selected); }, [selected]);
      React.useLayoutEffect(() => () => { if (binding?.token === token) publish(null); }, []);
      return React.createElement(original, props);
    }
    function WorkspaceSelectionView(props) {
      return typeof props.useWorkspaces === 'function' ? React.createElement(ObservedWorkspace, props) : React.createElement(original, props);
    }
    binding = { entry, original, view: WorkspaceSelectionView, token };
    try {
      entry.component = WorkspaceSelectionView;
      core.markDirty(key, record);
    } catch { release(); }
  };
  const unsubscribe = compatible ? slots.subscribe(key, reconcile) : () => {};
  try { if (compatible) reconcile(); } catch { release(); }
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      release();
      listeners.clear();
    },
  });
}

export function createShellPlugin(React, deps) {
// Runtime composition; the build wraps this in the dynamic Client factory.
const { installFrameAdapter, installRightbarSlotRecovery, createFrameViews, solveFrame, createPointerResize, shellCss, document, window, createWorkspaceClient } = deps;
const shellMessages = {
  en: { workspace: 'Workspace', sidebarResize: 'Resize sidebar', rightbarResize: 'Resize right panel', workspaceTabs: 'Workspace tabs' },
  zh: { workspace: '工作区', sidebarResize: '调整侧栏宽度', rightbarResize: '调整右栏宽度', workspaceTabs: '工作区页签' },
};
function findFrameClasses(document) {
  const keys = ['frame', 'sidebarCol', 'centerCol', 'rightbarCol', 'bottomRow', 'overlayLayer', 'leadingSeat'];
  const make = (prefix) => Object.fromEntries(keys.map((key) => [key, prefix + '_' + key]));
  // An already mounted stock frame is stronger evidence than a stylesheet guess.
  const frame = document.querySelector('[data-shell-overlay]')?.parentElement;
  const token = [...(frame?.classList ?? [])].find((name) => /^[A-Za-z0-9_-]+_frame$/u.test(name));
  if (token) {
    const prefix = token.slice(0, -6);
    const nodes = [...frame.children];
    if (keys.filter((key) => !['frame', 'leadingSeat'].includes(key)).every((key) => nodes.some((node) => node.classList.contains(prefix + '_' + key)))) return make(prefix);
  }
  const selectors = [document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css"]')?.textContent ?? ''];
  let remaining = 20000;
  const visit = (rules, depth = 0) => {
    if (depth > 8) return;
    for (const rule of rules) {
      if (--remaining < 0) return;
      if (rule.selectorText) selectors.push(rule.selectorText);
      if (rule.cssRules) visit(rule.cssRules, depth + 1);
    }
  };
  for (const sheet of document.styleSheets ?? []) { try { visit(sheet.cssRules); } catch {} }
  const text = selectors.join(' ');
  const candidates = new Set([...text.matchAll(/\.([A-Za-z0-9_-]+)_frame\b/gu)].map((match) => match[1]));
  for (const prefix of candidates) if (keys.every((key) => text.includes('.' + prefix + '_' + key))) return make(prefix);
  return null;
}
// The Chrome strip, the launcher page and the SSH panel own their React factories
// because they must stay import-free for the concatenated Client build.
const safeFactory = (fn, ...args) => {
  try { return fn(...args); } catch { return null; }
};
const chromeTabs = typeof deps.createChromeTabs === 'function' ? safeFactory(deps.createChromeTabs, React, { document, window }) : null;
const sessions = deps.createSessionHostPlugin?.(React, deps.primitives, deps);
return {
  inject: [...new Set(['slots', 'locale', 'layout', 'shortcuts', ...(sessions?.inject ?? [])])],
  apply(ctx) {
    // Embedded views still register sessions and accept navigation without mounting another frame.
    sessions?.apply(ctx);
    const embedded = [window.location.search, (window.location.hash ?? '').slice(1)].some((value) => new URLSearchParams(value).get('workspaceShellEmbedded') === '1');
    // Session status arrives from a service other plugins provide; waiting for it
    // keeps a profile without that UI domain from holding the whole Shell back.
    const withUiSession = (callback) => {
      if (typeof ctx.inject === 'function') ctx.inject(['uiSession'], callback);
      else callback(ctx);
    };
    if (embedded) {
      // The framing Shell owns the notification surface; the guest only reports
      // transitions and answers its open-Session request.
      if (typeof deps.createGuestNotificationBridge === 'function') withUiSession((scope) => {
        const bridge = safeFactory(deps.createGuestNotificationBridge, { window, ctx: scope });
        if (bridge) scope.effect(() => () => bridge.dispose(), 'workspace guest notifications');
      });
      return;
    }
    ctx.effect(() => ctx.locale.register('workspace-shell', shellMessages), 'workspace locale dictionaries');
    const activeLocale = ctx.locale?.getSnapshot?.().active || document?.documentElement?.lang || 'zh';
    const launcherModule = typeof deps.createLauncher === 'function'
      ? safeFactory(deps.createLauncher, React, { document, window, locale: activeLocale })
      : null;
    const classes = {};
    let controller;
    let notifications = null;
    const workspace = createWorkspaceClient({ ...deps, ctx, isFrameActive: () => controller?.getSnapshot().phase === 'active',
      onGuestNotification: (key, data) => notifications?.reportGuest(key, data) });
    ctx.effect(() => () => workspace.dispose(), 'workspace view ownership');
    const workspaceSelection = createWorkspaceSelection(React, ctx.slots);
    ctx.effect(() => () => workspaceSelection.dispose(), 'workspace selection observation');
    // Native notifications belong to Desktop: a plain browser page keeps its own
    // notification permission model and is deliberately left alone.
    const desktopNotification = typeof window.dshDesktop === 'object'
      && window.dshDesktop !== null
      && typeof window.dshDesktop.browser === 'object'
      && window.dshDesktop.browser !== null;
    if (desktopNotification && typeof deps.createNotificationCenter === 'function') {
      notifications = safeFactory(deps.createNotificationCenter, {
        window,
        document,
        workspace,
        localeOf: () => ctx.locale?.getSnapshot?.(),
        openLocalSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId); },
      });
      if (notifications) {
        ctx.effect(() => () => notifications.dispose(), 'workspace notifications');
        if (typeof deps.createSessionNotificationMonitor === 'function') withUiSession((scope) => {
          const monitor = safeFactory(deps.createSessionNotificationMonitor, {
            status: scope.uiSession?.sessionStatus,
            list: scope.sessions?.list,
            report: (payload) => notifications.reportHost(payload),
          });
          if (monitor) scope.effect(() => () => monitor.dispose(), 'workspace notification monitor');
        });
      }
    }
    ctx.provide('workspaceShell', Object.freeze({
      getSnapshot: workspace.tabs.getSnapshot, subscribe: workspace.tabs.subscribe,
      registerProvider: workspace.registerProvider, open: workspace.open, activate: workspace.activate,
      registerSshExtension: workspace.registerSshExtension,
      registerSessionNavigation: workspace.registerSessionNavigation,
      sessionTabs: workspace.sessionTabs, openSessionHost: workspace.openSessionHost,
      close: workspace.close, retry: workspace.retry, move: workspace.moveTab, openLauncher: workspace.openLauncher,
    }));
    const views = createFrameViews(React, {
      solveFrame, createPointerResize, css: shellCss, classes, ctx, document, window, workspace, workspaceSelection,
      getController: () => controller, chromeTabs, launcher: launcherModule,
    });
    ctx.effect(() => {
      controller = installFrameAdapter(ctx.slots, views.makeView, (entry) => {
        const code = Function.prototype.toString.call(entry.component);
        const current = findFrameClasses(document);
        if (!current || !code.includes('data-shell-overlay') || !code.includes('data-sidebar-collapsed')) return false;
        Object.assign(classes, current);
        return true;
      });
      return () => controller.dispose();
    }, 'workspace frame adapter');
    // A single render crash in the right column's DSH Slot entry makes the slot
    // core abdicate it for the rest of the page; the Sidebar store still reports
    // expanded, so the header's expand control never returns. Revive the crashed
    // entry a bounded number of times and, if it keeps failing, collapse the
    // column so the control is reachable.
    ctx.effect(() => {
      const recovery = installRightbarSlotRecovery?.(ctx.slots, {
        getService: (name) => ctx.get(name),
        onFailure: (error) => {
          try { console.error('workspace-shell: right Sidebar slot recovery exhausted', error); } catch { /* Diagnostics never break recovery. */ }
        },
      });
      return () => { try { recovery?.dispose?.(); } catch { /* Disposal is best effort. */ } };
    }, 'right Sidebar slot recovery');
  },
};
}
