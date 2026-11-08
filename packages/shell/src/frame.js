// Window frame: the permanent Local surface, Chrome-style workspace tabs, and one
// launcher page per `launcher` tab. Tab metadata is identity-based; the frame never
// reads a numeric generation and never owns provider resources itself.
export function createFrameViews(React, deps) {
  const { solveFrame, createPointerResize, css, classes, ctx, getController, document, window } = deps;
  const h = React.createElement;
  const t = ctx.locale.bind('workspace-shell');
  const request = (fn) => window.requestAnimationFrame(fn);
  const cancel = (id) => window.cancelAnimationFrame(id);
  const fenceKey = Symbol('wsh-portal-fence');
  const stripOptions = deps.chromeTabs ?? null;
  const ChromeTabStrip = stripOptions?.ChromeTabStrip ?? null;
  const chromeCss = typeof stripOptions?.css === 'string' ? stripOptions.css : '';
  const Launcher = deps.launcher?.Launcher ?? null;
  const launcherCss = typeof deps.launcher?.css === 'string' ? deps.launcher.css : '';
  const localTab = Object.freeze({ id: 'local', kind: 'profile-ui', title: '本地', phase: 'ready', identity: Object.freeze({}), closable: false });
  const fallbackTabSnapshot = Object.freeze({ activeId: 'local', tabs: [localTab] });
  const fallbackInfoSnapshot = Object.freeze({ phase: 'ready', profiles: [], runtimes: [] });
  const fallbackTabs = Object.freeze({ getSnapshot: () => fallbackTabSnapshot, subscribe: () => () => {} });
  const fallbackInfo = Object.freeze({ getSnapshot: () => fallbackInfoSnapshot, subscribe: () => () => {} });
  const EMPTY_CONNECTIONS = Object.freeze([]);
  const fallbackConnections = Object.freeze({ getSnapshot: () => EMPTY_CONNECTIONS, subscribe: () => () => {} });
  const fallbackWorkspaceSelection = Object.freeze({ getSnapshot: () => null, subscribe: () => () => {} });
  const fallbackAppearanceSnapshot = Object.freeze({ revision: 0 });
  const fallbackAppearance = Object.freeze({ getSnapshot: () => fallbackAppearanceSnapshot, subscribe: () => () => {} });
  const EMPTY_COLORS = Object.freeze([]);
  const copy = {
    newWorkspace: '新建工作区', close: '关闭页签', retry: '重试', opening: '正在打开', failed: '打开失败',
    local: '本地', workspaceError: '工作区操作失败', settings: '工作区',
  };
  const activeLocale = ctx.locale?.getSnapshot?.().active || document.documentElement.lang || 'zh';
  const english = !String(activeLocale).toLowerCase().startsWith('zh');
  const tabEditorCopy = english ? {
    title: 'Customize tab', original: 'Original name', name: 'Display name',
    hint: 'Leave the name empty and choose no marker to restore the default.', separator: ': ',
    marker: 'Color marker', none: 'None', cancel: 'Cancel', save: 'Save',
    colors: { blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', gray: 'Gray' },
  } : {
    title: '自定义页签', original: '原名称', name: '显示名称',
    hint: '名称留空并选择“无”即可恢复默认。', separator: '：',
    marker: '彩色标记', none: '无', cancel: '取消', save: '保存',
    colors: { blue: '蓝', green: '绿', amber: '橙', red: '红', gray: '灰' },
  };
  function friendlyError(code) {
    const safe = safeCode(code);
    const messages = english ? {
      TUI_PROFILE_CONFLICT: 'This profile declares both DSH TUI and Pi TUI. Keep only one TUI provider.',
      PROFILE_HOST_CONFLICT: 'This profile already has another running Host. Close or reuse that Host first.',
      TUI_NOT_INSTALLED: 'The selected TUI is not installed. Install it before opening the workspace.',
      VERSION_MISMATCH: 'The CLI or TUI version does not satisfy the configured or verified requirements. Check the installation and version requirements.',
      TUI_CONFIRM_REQUIRED: 'Before opening a TUI, confirm the independent instance and the risk of sharing profile settings and related data.',
      WORKSPACE_LAUNCHER_STALE: 'This launcher tab was replaced. Retry or close it.',
      TUI_COMMAND_INVALID: 'The launch command is invalid. Check quotes, escapes, line breaks, and length.',
      TAB_APPEARANCE_UNAVAILABLE: 'This tab has no stable identity, so its display cannot be customized.',
      TAB_APPEARANCE_INVALID: 'The tab name or color is invalid.',
      TAB_APPEARANCE_UNSAVED: 'The customization could not be saved.',
    } : {
      TUI_PROFILE_CONFLICT: '该 profile 同时声明了 DSH TUI 和 Pi TUI，请只保留一种终端实现。',
      PROFILE_HOST_CONFLICT: '该 profile 已有其它运行中的 Host，请先关闭或复用现有实例。',
      TUI_NOT_INSTALLED: '尚未安装所选 TUI，请先安装后再打开工作区。',
      VERSION_MISMATCH: 'CLI 或 TUI 版本不符合当前配置或已验证范围，请检查安装与版本要求。',
      TUI_CONFIRM_REQUIRED: '打开 TUI 前，请确认将启动独立实例，并了解共享 profile 设置与相关数据的风险。',
      WORKSPACE_LAUNCHER_STALE: '该 launcher 页签已被替换，请重试或关闭。',
      TUI_COMMAND_INVALID: '启动命令无效，请检查引号、转义、换行和长度。',
      TAB_APPEARANCE_UNAVAILABLE: '该页签没有可保存的稳定身份，无法自定义显示。',
      TAB_APPEARANCE_INVALID: '页签名称或颜色无效。',
      TAB_APPEARANCE_UNSAVED: '自定义显示未能保存。',
    };
    return messages[safe] ? `${messages[safe]} [${safe}]` : safe;
  }
  function safeCode(value) {
    let code;
    try { code = typeof value === 'string' ? value : value?.code; } catch {}
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'WORKSPACE_ACTION_FAILED';
  }
  function domId(kind, id) { return `wsh-${kind}-${encodeURIComponent(id)}`; }

  const Panel = React.memo(function Panel({ renderSlot, usePanelInfo }) {
    const panel = usePanelInfo((state) => state.activePanelId);
    return renderSlot('main', {}, { entryKey: panel ?? 'conversation' });
  });
  function Title({ usePanelInfo, useSessions, activeTab, appearance }) {
    const panel = usePanelInfo((state) => state.activePanelId);
    const title = useSessions((state) => Object.values(state.byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.title);
    const activeTitle = appearance?.name || activeTab?.title;
    React.useEffect(() => {
      document.title = activeTab && activeTab.id !== 'local' && activeTitle ? `${activeTitle} — DeepSeek Harness` : !panel && title ? title + ' — DeepSeek Harness' : 'DeepSeek Harness';
      return () => { document.title = 'DeepSeek Harness'; };
    }, [panel, title, activeTab, activeTitle]);
    return null;
  }
  function Resize({ side, width, actions, onDragging, offset = 0 }) {
    const write = side === 'sidebar' ? actions.setSidebar : actions.setRightbar;
    const drag = React.useMemo(() => createPointerResize({ request, cancel, write, end: () => onDragging(false) }), [write, onDragging]);
    React.useEffect(() => () => drag.dispose(), [drag]);
    return h('div', { className: 'wsh-resize', role: 'separator', tabIndex: 0,
      'data-side': side, style: side === 'rightbar' ? { left: offset } : undefined, 'aria-orientation': 'vertical', 'aria-label': t(side + 'Resize'),
      'aria-valuenow': Math.round(width), 'aria-valuemin': side === 'sidebar' ? 264 : 300, 'aria-valuemax': side === 'sidebar' ? 420 : undefined,
      onPointerDown: (event) => { if (drag.start(event, width, side === 'sidebar' ? 1 : -1)) onDragging(true); },
      onPointerMove: drag.move, onPointerUp: drag.finish, onPointerCancel: drag.cancel, onLostPointerCapture: drag.cancel,
      onKeyDown: (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        write(width + (event.key === 'ArrowRight' ? 16 : -16) * (side === 'sidebar' ? 1 : -1));
      },
    });
  }

  // Minimal accessible strip used only when the Chrome tab module is unavailable
  // (isolated tests and degraded startup). Production always injects the real one.
  function FallbackStrip({ tabs, activeId, onSelect, onClose, onAdd, onMove, getAppearance }) {
    const displayTitle = (tab) => {
      let appearance = null;
      try { appearance = typeof getAppearance === 'function' ? getAppearance(tab) : null; } catch { /* Fall back to the stored title. */ }
      return appearance && typeof appearance.name === 'string' && appearance.name ? appearance.name : tab.title;
    };
    return h('div', { className: 'wsh-tabstrip', role: 'tablist', 'aria-label': copy.settings, 'data-fallback-strip': '' },
      tabs.map((tab, index) => h('div', { key: tab.id, className: 'wsh-tab', 'data-active': tab.id === activeId || undefined },
        h('button', { type: 'button', role: 'tab', id: domId('tab', tab.id), className: 'wsh-tab-button',
          'aria-selected': tab.id === activeId, 'aria-controls': domId('panel', tab.id), onClick: () => onSelect(tab.id),
          onKeyDown: (event) => {
            if (!onMove || !['Alt+ArrowLeft', 'Alt+ArrowRight'].includes((event.altKey ? 'Alt+' : '') + event.key)) return;
            event.preventDefault();
            onMove(tab.id, Math.max(0, Math.min(tabs.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))));
          } }, displayTitle(tab)),
        tab.closable ? h('button', { type: 'button', className: 'wsh-tab-close', 'aria-label': `${copy.close} ${displayTitle(tab)}`, onClick: () => onClose(tab.id) }, '×') : null)),
      h('button', { type: 'button', className: 'wsh-button', 'aria-label': copy.newWorkspace, onClick: onAdd }, '+'));
  }

  function installPortalFence(frame) {
    if (!frame || !document.body || typeof window.MutationObserver !== 'function') return () => {};
    const records = [];
    const observers = [];
    let disposed = false;
    const hold = (node) => {
      if (!node || ['STYLE', 'SCRIPT', 'LINK'].includes(node.tagName) || node[fenceKey] || !node.style) return;
      const token = {};
      const record = {
        node, token, display: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display'),
        inert: node.inert === true, aria: node.getAttribute('aria-hidden'), hadAria: node.hasAttribute('aria-hidden'),
      };
      node[fenceKey] = token;
      node.style.setProperty('display', 'none', 'important'); node.inert = true; node.setAttribute('aria-hidden', 'true');
      records.push(record);
    };
    const scan = (parent, branch) => { for (const node of [...(parent.children ?? [])]) if (node !== branch) hold(node); };
    let branch = frame;
    let parent = frame.parentElement;
    while (parent && parent !== document.documentElement) {
      scan(parent, branch);
      if (typeof window.MutationObserver === 'function') {
        const observedParent = parent;
        const observedBranch = branch;
        const observer = new window.MutationObserver(() => scan(observedParent, observedBranch));
        observer.observe(observedParent, { childList: true }); observers.push(observer);
      }
      branch = parent; parent = parent.parentElement;
    }
    return () => {
      if (disposed) return;
      disposed = true;
      for (const observer of observers) observer.disconnect();
      for (const record of records.reverse()) {
        const { node, token } = record;
        if (node[fenceKey] !== token) continue;
        delete node[fenceKey];
        if (node.style.getPropertyValue('display') === 'none' && node.style.getPropertyPriority('display') === 'important') {
          if (record.display) node.style.setProperty('display', record.display, record.priority);
          else node.style.removeProperty('display');
        }
        if (node.inert === true) node.inert = record.inert;
        if (node.getAttribute('aria-hidden') === 'true') {
          if (record.hadAria) node.setAttribute('aria-hidden', record.aria);
          else node.removeAttribute('aria-hidden');
        }
      }
    };
  }

  function LauncherSurface({ tab, workspace, workspaceInfo, connections, extension, localDefaultCwd, onClose, onError, onModalChange }) {
    if (Launcher && workspace) {
      return h(Launcher, {
        tabId: tab.id, workspace, info: workspaceInfo, connections, localCwd: localDefaultCwd,
        ssh: extension?.SshLauncher ?? null,
        onClose: () => onClose(tab), onError, onModalChange,
      });
    }
    return h('div', { className: 'wsh-launcher wsh-launcher-empty', role: 'tabpanel', 'data-launcher': 'unavailable' },
      h('h1', { className: 'wsh-launcher-title' }, copy.newWorkspace),
      h('p', { className: 'wsh-muted' }, english ? 'The launcher component is unavailable.' : '启动器组件不可用。'));
  }

  function Surface({ tab, active, modal, tabs, workspace, workspaceInfo, connections, extension, localDefaultCwd, onError, onRetry, onClose, onModalChange }) {
    const container = React.useRef(null);
    const launcher = tab.kind === 'launcher';
    const suspendedSsh = tab.error?.code === 'SSH_COMPONENT_DISABLED';
    const statusText = suspendedSsh
      ? extension
        ? (english ? 'SSH component is enabled. Retry to reconnect this tab.' : 'SSH 组件已启用，请重试连接此页签。')
        : (english ? 'SSH component is disabled' : 'SSH 组件已停用')
      : tab.phase === 'error' ? `${copy.failed}: ${friendlyError(tab.error?.code ?? 'TAB_FAILED')}` : copy.opening;
    // A stable per-tab setter keeps the launcher's modal effect from re-running on
    // every frame render (which would otherwise loop through setState).
    const setModal = React.useCallback((open) => onModalChange?.(tab.id, Boolean(open)), [onModalChange, tab.id]);
    React.useLayoutEffect(() => {
      let detach;
      try { detach = tabs.mount(tab.id, container.current); }
      catch (error) { onError(safeCode(error)); }
      return () => {
        try { Promise.resolve(detach?.()).catch((error) => onError(safeCode(error))); }
        catch (error) { onError(safeCode(error)); }
      };
    }, [tabs, tab.id, tab.identity]);
    return h('section', {
      className: 'wsh-workspace-surface', role: 'tabpanel', id: domId('panel', tab.id), 'aria-labelledby': domId('tab', tab.id),
      'aria-hidden': !active || modal, inert: !active || modal, 'data-active': active || undefined, 'data-tab-id': tab.id,
      'data-kind': tab.kind, 'data-phase': tab.phase,
    },
      h('div', { className: 'wsh-workspace-viewport', ref: container, 'data-workspace-viewport': tab.id }),
      launcher ? h(LauncherSurface, { tab, workspace, workspaceInfo, connections, extension, localDefaultCwd, onClose, onError, onModalChange: setModal }) : null,
      !launcher && tab.phase !== 'ready' ? h('div', { className: 'wsh-surface-status' },
        h('span', { role: 'status' }, statusText),
        tab.phase === 'error' ? h('div', { className: 'wsh-sheet-actions' },
          h('button', { type: 'button', className: 'wsh-button', disabled: suspendedSsh && !extension, onClick: () => onRetry(tab) }, copy.retry),
          h('button', { type: 'button', className: 'wsh-button', onClick: () => onClose(tab) }, copy.close)) : null) : null);
  }

  function TabAppearanceDialog({ tab, initial, colors, busy, error, onCancel, onSave }) {
    const [name, setName] = React.useState(typeof initial?.name === 'string' ? initial.name : '');
    const [color, setColor] = React.useState(typeof initial?.color === 'string' ? initial.color : '');
    const input = React.useRef(null);
    const section = React.useRef(null);
    React.useEffect(() => {
      try { input.current?.focus?.({ preventScroll: true }); } catch { /* Focus entry is best effort. */ }
    }, []);
    const submit = (event) => {
      event?.preventDefault?.();
      if (busy) return;
      onSave({ name: name.trim(), color: color || null });
    };
    const onKeyDown = (event) => {
      event.stopPropagation?.();
      if (event.key === 'Escape') {
        event.preventDefault?.();
        if (!busy) onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...(section.current?.querySelectorAll?.('button:not([disabled]),input:not([disabled])') ?? [])];
      if (!items.length) return;
      const active = document?.activeElement;
      const index = items.indexOf(active);
      const next = event.shiftKey
        ? (index <= 0 ? items.length - 1 : index - 1)
        : (index === items.length - 1 || index < 0 ? 0 : index + 1);
      event.preventDefault?.();
      items[next]?.focus?.({ preventScroll: true });
    };
    const options = [['', 'none', tabEditorCopy.none], ...colors.map((id) => [id, id, tabEditorCopy.colors[id] ?? id])];
    return h('div', { className: 'wsh-sheet-backdrop', 'data-tab-editor-backdrop': '' },
      h('form', {
        ref: section, className: 'wsh-sheet wsh-tab-editor', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'wsh-tab-editor-title', 'data-tab-editor': String(tab.id), onSubmit: submit, onKeyDown,
      },
      h('div', { className: 'wsh-sheet-title' }, h('strong', { id: 'wsh-tab-editor-title' }, tabEditorCopy.title)),
      h('p', { className: 'wsh-muted' }, `${tabEditorCopy.original}${tabEditorCopy.separator}${tab.title ?? ''}`),
      h('label', { className: 'wsh-field' }, tabEditorCopy.name,
        h('input', {
          ref: input, type: 'text', value: name, maxLength: 64, placeholder: tab.title ?? '', disabled: busy,
          'data-tab-name': '', onChange: (event) => setName(event.target.value),
        })),
      h('p', { className: 'wsh-muted' }, tabEditorCopy.hint),
      h('div', { className: 'wsh-tab-colors', role: 'radiogroup', 'aria-label': tabEditorCopy.marker },
        options.map(([value, token, label]) => h('button', {
          key: token, type: 'button', role: 'radio', className: 'wsh-swatch',
          'aria-checked': (color || '') === value ? 'true' : 'false', 'aria-label': label, title: label,
          'data-tab-color': token, disabled: busy, onClick: () => setColor(value),
        }, value ? null : tabEditorCopy.none))),
      error ? h('p', { className: 'wsh-warning', role: 'alert' }, friendlyError(error)) : null,
      h('div', { className: 'wsh-sheet-actions' },
        h('button', { type: 'button', className: 'wsh-button', disabled: busy, onClick: onCancel, 'data-tab-cancel': '' }, tabEditorCopy.cancel),
        h('button', { type: 'submit', className: 'wsh-button wsh-primary', disabled: busy, 'data-tab-save': '' }, tabEditorCopy.save))));
  }

  function Frame(props) {
    const { useStore, useSessions, usePanelInfo, renderSlot, actions } = props;
    const workspace = deps.workspace;
    const tabStore = workspace?.tabs ?? fallbackTabs;
    const infoStore = workspace?.info ?? fallbackInfo;
    const connectionStore = workspace?.connections ?? fallbackConnections;
    const extensionStore = workspace?.sshExtension ?? { subscribe: fallbackConnections.subscribe, getSnapshot: () => null };
    const extension = React.useSyncExternalStore(extensionStore.subscribe, extensionStore.getSnapshot);
    const sessionExtensionStore = workspace?.sessionNavigationExtension ?? { subscribe: fallbackConnections.subscribe, getSnapshot: () => null };
    const sessionExtension = React.useSyncExternalStore(sessionExtensionStore.subscribe, sessionExtensionStore.getSnapshot);
    const tabState = React.useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot);
    const workspaceInfo = React.useSyncExternalStore(infoStore.subscribe, infoStore.getSnapshot);
    const connections = React.useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot);
    const appearanceStore = workspace?.appearance ?? fallbackAppearance;
    React.useSyncExternalStore(appearanceStore.subscribe, appearanceStore.getSnapshot);
    const appearanceColors = Array.isArray(workspace?.appearanceColors) ? workspace.appearanceColors : EMPTY_COLORS;
    const appearanceOf = React.useCallback((tab) => {
      try { return workspace?.getTabAppearance?.(tab) ?? null; } catch { return null; }
    }, [workspace]);
    const canEditTab = React.useCallback((tab) => {
      try { return workspace?.canCustomizeTab?.(tab) === true; } catch { return false; }
    }, [workspace]);
    const tabs = tabState.tabs;
    const activeId = tabState.activeId ?? 'local';
    const activeTab = tabs.find((tab) => tab.id === activeId) ?? localTab;
    const activeAppearance = appearanceOf(activeTab);
    const localActive = activeId === 'local';
    const selectionStore = deps.workspaceSelection ?? fallbackWorkspaceSelection;
    const selectedWorkspaceCwd = React.useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
    const mainSessionCount = useSessions((state) => Object.values(state.byId ?? {}).filter((row) => (row.retainedBy?.mainView ?? 0) > 0).length);
    const sessionCwd = useSessions((state) => {
      const rows = Object.values(state.byId ?? {}).filter((row) => (row.retainedBy?.mainView ?? 0) > 0);
      if (rows.length !== 1) return null;
      const value = rows[0].projectionValues?.workingDirectory;
      return typeof value === 'string' && value.trim() ? value : null;
    });
    const localDefaultCwd = mainSessionCount === 0 ? selectedWorkspaceCwd : sessionCwd;
    const info = useStore((state) => state.layoutInfo);
    const root = React.useRef(null);
    const actionsRef = React.useRef(actions);
    actionsRef.current = actions;
    const [dragging, setDragging] = React.useState(false);
    const [animating, setAnimating] = React.useState(false);
    const [modals, setModals] = React.useState({});
    const [busy, setBusy] = React.useState('');
    const [errorCode, setErrorCode] = React.useState(null);
    const [editingTabId, setEditingTabId] = React.useState(null);
    const focusRequest = React.useRef(null);
    const localFocus = React.useRef(null);
    // A Surface may hold an Electron <webview>. Reordering the strip must not move that
    // node in the DOM, so every remote Surface keeps its creation slot for this mount.
    const surfaceSlots = React.useRef({ next: 0, slots: new Map() });
    const editingTab = editingTabId ? tabs.find((tab) => tab.id === editingTabId) ?? null : null;
    const overlayOpen = Object.keys(modals).some((key) => modals[key]) || editingTab !== null;
    const native = document.documentElement.dataset.platform === 'darwin' || document.documentElement.hasAttribute('data-windows-titlebar');
    const g = solveFrame(info, native ? 0 : 56);
    const prior = React.useRef({ width: g.width, toggle: '' });
    const toggle = String(g.collapsed) + ':' + String(info.rightbarTrack);
    const setModalFor = React.useCallback((id, open) => {
      setModals((current) => current[id] === open ? current : { ...current, [id]: open });
    }, []);
    const setExtensionModal = React.useCallback((open) => setModalFor('ssh-component', open), [setModalFor]);
    const setSessionModal = React.useCallback((open) => setModalFor('session-navigation', open), [setModalFor]);
    const clearModal = React.useCallback((id) => {
      setModals((current) => {
        if (!Object.hasOwn(current, id)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, []);
    const run = React.useCallback(async (key, action) => {
      if (busy) return undefined;
      setBusy(key); setErrorCode(null);
      try { return await action(); }
      catch (error) { setErrorCode(safeCode(error)); return undefined; }
      finally { setBusy(''); }
    }, [busy]);
    const editTab = React.useCallback((id) => {
      if (!workspace) return;
      const tab = tabStore.getSnapshot().tabs.find((item) => item.id === id);
      if (!tab || !canEditTab(tab)) return;
      setErrorCode(null);
      setEditingTabId(id);
    }, [workspace, tabStore, canEditTab]);
    const cancelAppearance = React.useCallback(() => {
      setEditingTabId(null);
      setErrorCode(null);
    }, []);
    const saveAppearance = React.useCallback(async (value) => {
      if (!workspace || !editingTabId) return;
      const id = editingTabId;
      const result = await run(`appearance:${id}`, () => workspace.setTabAppearance(id, value));
      if (result === true) setEditingTabId(null);
    }, [workspace, editingTabId, run]);
    React.useEffect(() => {
      if (editingTabId && !tabs.some((tab) => tab.id === editingTabId)) {
        setEditingTabId(null);
        setErrorCode(null);
      }
    }, [tabs, editingTabId]);
    const selectTab = React.useCallback(async (id) => {
      if (!workspace) return;
      const tab = tabStore.getSnapshot().tabs.find((item) => item.id === id);
      if (tab?.phase === 'ready') focusRequest.current = id;
      await run(`activate:${id}`, async () => {
        const selected = await workspace.activate(id);
        if (!selected) focusRequest.current = null;
      });
    }, [workspace, tabStore, run]);
    React.useLayoutEffect(() => {
      const requested = focusRequest.current;
      if (!requested || requested !== activeId) return;
      focusRequest.current = null;
      if (requested === 'local') {
        try { localFocus.current?.focus?.({ preventScroll: true }); } catch { /* Focus restoration is best effort. */ }
        return;
      }
      const tab = tabStore.getSnapshot().tabs.find((item) => item.id === requested);
      if (tab?.phase !== 'ready') return;
      try { Promise.resolve(tabStore.activate(requested, { focus: true })).catch((error) => setErrorCode(safeCode(error))); }
      catch (error) { setErrorCode(safeCode(error)); }
    }, [activeId, tabStore]);
    React.useLayoutEffect(() => {
      if (activeId === 'local' || !workspace) return;
      try { Promise.resolve(tabStore.resize(activeId)).catch((error) => setErrorCode(safeCode(error))); }
      catch (error) { setErrorCode(safeCode(error)); }
    }, [activeId, tabStore, workspace]);
    // Modals in the launcher page still pause Local shortcuts and inert the frame.
    React.useLayoutEffect(() => {
      if (!workspace || typeof workspace.setOverlay !== 'function') return;
      let current = true;
      try {
        Promise.resolve(workspace.setOverlay(overlayOpen)).catch((error) => { if (current) setErrorCode(safeCode(error)); });
      } catch (error) { if (current) setErrorCode(safeCode(error)); }
      return () => { current = false; };
    }, [workspace, overlayOpen]);
    React.useLayoutEffect(() => () => {
      if (!workspace || typeof workspace.setOverlay !== 'function') return;
      try { Promise.resolve(workspace.setOverlay(false)).catch(() => {}); } catch { /* Unmount cleanup cannot report through React state. */ }
    }, [workspace]);
    React.useLayoutEffect(() => localActive && !overlayOpen ? undefined : installPortalFence(root.current), [activeId, overlayOpen]);
    // The frame owns the whole window, so document scrolling is never wanted. A body-level
    // inline remnant from another plugin (an icon <svg> appended to body, for example) adds
    // a line box past #root and lets the page scroll away from the frame edges. Lock the
    // document while the frame is mounted and drop any offset that predates it.
    React.useLayoutEffect(() => {
      const html = document.documentElement;
      try { html?.setAttribute?.('data-workspace-shell-active', ''); } catch { /* Attribute is best effort. */ }
      try { window.scrollTo?.(0, 0); } catch { /* Document offset is best effort. */ }
      return () => { try { html?.removeAttribute?.('data-workspace-shell-active'); } catch { /* Cleanup is best effort. */ } };
    }, []);
    React.useLayoutEffect(() => {
      const old = prior.current;
      prior.current = { width: g.width, toggle };
      if (old.toggle && old.toggle !== toggle && old.width === g.width) setAnimating(true);
    }, [toggle, g.width]);
    React.useEffect(() => {
      if (!animating) return;
      const timer = window.setTimeout(() => setAnimating(false), 600);
      return () => window.clearTimeout(timer);
    }, [animating, toggle]);
    React.useLayoutEffect(() => {
      const element = root.current;
      if (!element) return;
      let pending;
      let disposed = false;
      let lastWidth = -1;
      let lastFrame = null;
      const measure = () => {
        pending = undefined;
        if (disposed) return;
        const rect = element.getBoundingClientRect();
        const width = Math.round(rect.width);
        if (width > 0 && width !== lastWidth) {
          lastWidth = width;
          actionsRef.current?.setViewportWidth?.(width);
        }
        const header = element.querySelector?.('.wsh-header')?.getBoundingClientRect();
        const main = element.querySelector?.('.wsh-main')?.getBoundingClientRect();
        const nextFrame = {
          width,
          height: Math.round(rect.height),
          native: Boolean(window.dshDesktop),
          aligned: Boolean(header && main && Math.abs(header.bottom - main.top) < 1),
        };
        if (lastFrame && lastFrame.width === nextFrame.width && lastFrame.height === nextFrame.height
          && lastFrame.native === nextFrame.native && lastFrame.aligned === nextFrame.aligned) return;
        lastFrame = nextFrame;
        getController().reportFrame(nextFrame);
      };
      const changed = () => { if (pending === undefined) pending = request(measure); };
      const observer = new window.ResizeObserver(changed);
      measure(); observer.observe(element);
      return () => { disposed = true; observer.disconnect(); if (pending !== undefined) cancel(pending); getController().reportFrame(null); };
    }, []);
    const sidebar = React.useMemo(() => renderSlot('sidebar', { collapsed: g.collapsed, width: g.sidebar }), [renderSlot, g.collapsed, g.sidebar]);
    const rightbar = React.useMemo(() => renderSlot('rightbar', { width: g.normalRight, viewportWidth: g.width, canShow: g.normalRight > 0 }), [renderSlot, g.normalRight, g.width]);
    const bottom = React.useMemo(() => renderSlot('shell.bottom', {}), [renderSlot]);
    const overlay = React.useMemo(() => renderSlot('shell.overlay', {}), [renderSlot]);
    const leading = React.useMemo(() => renderSlot('shell.leading', {}), [renderSlot]);
    const closeTab = React.useCallback(async (tab) => {
      if (!workspace || tab.id === 'local') return;
      clearModal(tab.id);
      await run(`close:${tab.id}`, () => workspace.close(tab.id));
    }, [workspace, run, clearModal]);
    const retryTab = React.useCallback(async (tab) => { if (workspace) await run(`retry:${tab.id}`, () => workspace.retry(tab.id)); }, [workspace, run]);
    // `+` creates and selects a launcher tab immediately; it never opens a dialog.
    const addLauncher = React.useCallback(async () => {
      if (!workspace) return;
      await run('launcher', () => workspace.openLauncher());
    }, [workspace, run]);
    const moveTab = React.useCallback((id, targetIndex) => {
      if (!workspace) return;
      try { workspace.moveTab?.(id, targetIndex); } catch (error) { setErrorCode(safeCode(error)); }
    }, [workspace]);
    const statusOf = React.useCallback((tab) => {
      try { return workspace?.getTabStatus?.(tab) ?? null; } catch { return null; }
    }, [workspace]);
    const stripProps = {
      tabs, activeId, getStatus: statusOf, getAppearance: appearanceOf,
      labels: { edit: english ? 'Edit tab name and color' : '编辑页签名称与彩色标记' },
      onSelect: (id) => void selectTab(id),
      onClose: (id) => { const tab = tabs.find((item) => item.id === id); if (tab) void closeTab(tab); },
      ...(workspace ? { onAdd: () => void addLauncher(), onMove: moveTab, onEdit: editTab, canEdit: canEditTab } : {}),
    };
    const tabsView = ChromeTabStrip
      ? h(ChromeTabStrip, stripProps)
      : h(FallbackStrip, stripProps);
    const remotes = tabs.filter((tab) => tab.id !== 'local');
    const order = surfaceSlots.current;
    const live = new Set(remotes.map((tab) => tab.id));
    for (const id of [...order.slots.keys()]) if (!live.has(id)) order.slots.delete(id);
    for (const tab of remotes) if (!order.slots.has(tab.id)) order.slots.set(tab.id, order.next++);
    remotes.sort((left, right) => order.slots.get(left.id) - order.slots.get(right.id));
    return h('div', { ref: root, className: classes.frame + ' wsh-frame', 'data-workspace-shell': 'active',
      'data-sidebar-collapsed': g.collapsed || undefined,
      'data-rightbar-collapsed': g.right === 0 || undefined,
      'data-rightbar-fullscreen': info.rightbarFullscreen || undefined,
      'data-rightbar-instant': info.rightbarInstant || undefined,
      'data-dragging': dragging || undefined, 'data-animating': animating || undefined,
      style: { gridTemplateColumns: g.sidebar + 'px minmax(0,1fr) ' + g.right + 'px', ...(document.documentElement.hasAttribute('data-windows-titlebar') ? { '--dsh-windows-sidebar-width': g.sidebar + 'px' } : {}) },
      onTransitionEnd: (event) => { if (event.target === root.current && event.propertyName === 'grid-template-columns') setAnimating(false); },
    },
      h('style', { 'data-workspace-shell-style': true }, [css, launcherCss, chromeCss, extension?.css].filter(Boolean).join('\n')),
      h(Title, { useSessions, usePanelInfo, activeTab, appearance: activeAppearance }),
      h('header', { className: 'wsh-header', inert: overlayOpen, 'aria-hidden': overlayOpen },
        document.documentElement.dataset.platform === 'darwin' && g.sidebar === 0 && h('div', {
          className: 'wsh-leading', 'data-shell-leading': true, 'data-local-active': localActive,
          inert: !localActive || overlayOpen, 'aria-hidden': !localActive || overlayOpen,
        }, leading),
        h('div', { className: 'wsh-tabstrip-host', inert: overlayOpen, 'aria-hidden': overlayOpen }, tabsView),
        errorCode || workspaceInfo.errorCode ? h('div', { className: 'wsh-error-slot', role: 'alert', 'data-workspace-error': true },
          h('span', { className: 'wsh-error' }, friendlyError(errorCode ?? workspaceInfo.errorCode)),
          h('button', { type: 'button', className: 'wsh-button wsh-error-dismiss', 'aria-label': copy.close, onClick: () => setErrorCode(null) }, '×')) : null),
      h('div', {
        className: 'wsh-local-surface', role: 'tabpanel', id: domId('panel', 'local'), 'aria-labelledby': domId('tab', 'local'),
        'aria-hidden': !localActive || overlayOpen, inert: !localActive || overlayOpen, 'data-local-active': localActive,
        onFocusCapture: (event) => { if (localActive && !overlayOpen && event.target) localFocus.current = event.target; },
      },
        h('div', { className: classes.sidebarCol + ' wsh-column', style: { gridColumn: 1 } }, sidebar),
        h('div', { className: classes.centerCol + ' wsh-column wsh-main', style: { gridColumn: 2 } }, h(Panel, { renderSlot, usePanelInfo })),
        h('div', { className: classes.rightbarCol + ' wsh-column', style: { gridColumn: 3 }, 'data-rightbar-col': true }, rightbar),
        h('div', { className: classes.bottomRow + ' wsh-bottom', 'data-shell-bottom': true }, bottom),
        h('div', { className: classes.overlayLayer + ' wsh-overlay', 'data-shell-overlay': true }, overlay),
        !g.collapsed && h(Resize, { key: 'left-resize', side: 'sidebar', width: g.sidebar, actions, onDragging: setDragging }),
        info.rightbarShown && !info.rightbarFullscreen && g.normalRight > 0 && h(Resize, { key: 'right-resize', side: 'rightbar', width: g.normalRight, offset: g.right - g.normalRight, actions, onDragging: setDragging })),
      remotes.map((tab) => h(Surface, {
        key: tab.id, tab, active: tab.id === activeId, modal: overlayOpen, tabs: tabStore, workspace, workspaceInfo, connections, extension, localDefaultCwd,
        onError: setErrorCode, onRetry: retryTab, onClose: closeTab,
        onModalChange: setModalFor,
      })),
      editingTab ? h(TabAppearanceDialog, {
        key: editingTab.id, tab: editingTab, initial: appearanceOf(editingTab), colors: appearanceColors,
        busy: Boolean(busy), error: errorCode, onCancel: cancelAppearance, onSave: saveAppearance,
      }) : null,
      extension?.Overlay ? h(extension.Overlay, { onModalChange: setExtensionModal, locale: activeLocale }) : null,
      sessionExtension?.Overlay ? h(sessionExtension.Overlay, { onModalChange: setSessionModal }) : null);
  }
  function makeView(Original, cell, fail) {
    class FrameBoundary extends React.Component {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch() { fail(); }
      render() { return h(this.state.failed ? Original : Frame, this.props.frameProps); }
    }
    return function WorkspaceShellRoot(props) {
      return cell.active ? h(FrameBoundary, { frameProps: props }) : h(Original, props);
    };
  }
  return { Frame, makeView };
}
