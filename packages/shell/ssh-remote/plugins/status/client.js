window.__ModuleLoader__.load({
  id: 'dsh-workspace-shell-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;
    const messages = {
      en: {
        remote: 'SSH', back: 'Switch to local', title: 'Return to the local DSH profile',
        version: 'Remote DSH version', workspace: 'Remote workspace', checking: 'Checking remote status…',
        unavailable: 'Status unavailable', noReturnUrl: 'The local return address is unavailable',
        invalidResponse: 'The remote status response is invalid', navigationFailed: 'The local address could not be opened',
        pluginsPage: 'SSH Plugins', pluginsTitle: 'Remote plugins',
        pluginsSubtitle: 'Manage plugins on this remote host. Your local profile stays unchanged.',
        remotePlugins: 'Remote installed', localPlugins: 'Available from local (snapshot)',
        remoteLive: 'Live remote profile', localSnapshot: 'Local profile snapshot',
        snapshotHint: 'This list is a snapshot shared from your local profile, not a live list of this computer.',
        noSnapshot: 'No local snapshot has been shared', noSnapshotHint: 'Reconnect from the local SSH manager to share the local plugin snapshot.',
        refresh: 'Refresh', refreshing: 'Refreshing…', loading: 'Loading plugins…', retry: 'Try again',
        install: 'Install on remote', installing: 'Installing…', working: 'Applying…',
        enable: 'Enable', disable: 'Disable', remove: 'Uninstall…', enabled: 'Enabled', disabled: 'Disabled',
        installed: 'Installed on remote', missing: 'Unavailable in snapshot',
        versionConflict: 'Different version installed', versionConflictHint: 'The remote version differs from this snapshot. Uninstall it from Remote installed before installing this version.',
        protectedPlugin: 'This plugin cannot be uninstalled', official: 'Official',
        noLocalPlugins: 'No third-party plugins in this snapshot', noLocalHint: 'Only third-party plugins shared from the local profile appear here.',
        noRemotePlugins: 'No plugins installed on this remote host', noRemoteHint: 'Open Available from local to install a plugin from the shared snapshot.',
        browseLocal: 'Browse local snapshot', search: 'Search plugins', searchPlaceholder: 'Search by name, package or description',
        clearSearch: 'Clear search', noMatches: 'No matching plugins', noMatchesHint: 'Try another name or clear the search.',
        results: 'plugins shown', more: 'More actions', dismiss: 'Dismiss', loadFailed: 'Could not load plugins',
        stale: 'Showing the last loaded list. Refresh to check the remote profile.',
        pendingBuilds: 'Build scripts require approval', approveBuilds: 'Approve builds and install', cancel: 'Cancel',
        buildMessage: 'These scripts will run on the remote host. Approving them grants persistent permission in the remote profile. Only approve scripts you trust.',
        installDone: 'Plugin installation completed.', operationDone: 'Remote plugin updated.', partialFailure: 'The plugin operation did not fully complete.',
        restartRequired: 'Restart the remote Host for this change to take effect.', notApplied: 'The change has not been applied. Check the remote profile before trying again.',
        removeTitle: 'Uninstall remote plugin', removeMessage: 'Remove this plugin from the remote profile. This does not change the local profile.',
        confirmRemove: 'Uninstall from remote', errorCode: 'Error code', requestFailed: 'The plugin operation failed.',
      },
      zh: {
        remote: 'SSH', back: '切换到本地', title: '返回本地 DSH profile',
        version: '远端 DSH 版本', workspace: '远端工作区', checking: '正在检查远端状态…',
        unavailable: '状态不可用', noReturnUrl: '本地返回地址不可用',
        invalidResponse: '远端状态响应无效', navigationFailed: '无法打开本地地址',
        pluginsPage: 'SSH 插件', pluginsTitle: '远端插件',
        pluginsSubtitle: '管理这台远端主机上的插件，不修改本地 profile。',
        remotePlugins: '远端已安装', localPlugins: '可从本地安装（快照）',
        remoteLive: '远端 profile 实时列表', localSnapshot: '本地 profile 快照',
        snapshotHint: '此列表来自本地 profile 分享的快照，不是本机的实时插件列表。',
        noSnapshot: '尚未分享本地快照', noSnapshotHint: '从本地 SSH 管理页重新连接，以分享本地插件快照。',
        refresh: '刷新', refreshing: '正在刷新…', loading: '正在加载插件…', retry: '重试',
        install: '安装到远端', installing: '正在安装…', working: '正在应用…',
        enable: '启用', disable: '停用', remove: '卸载…', enabled: '已启用', disabled: '已停用',
        installed: '远端已安装', missing: '快照中的插件不可用',
        versionConflict: '远端版本不同', versionConflictHint: '远端已安装的版本与快照不同。请先在“远端已安装”中卸载，再安装此版本。',
        protectedPlugin: '此插件不可卸载', official: '官方',
        noLocalPlugins: '快照中没有第三方插件', noLocalHint: '这里只列出本地 profile 分享的第三方插件。',
        noRemotePlugins: '这台远端主机尚未安装插件', noRemoteHint: '打开“可从本地安装”，从分享的快照中选择插件。',
        browseLocal: '查看本地快照', search: '搜索插件', searchPlaceholder: '搜索名称、包名或描述',
        clearSearch: '清除搜索', noMatches: '没有匹配的插件', noMatchesHint: '换个名称，或清除搜索条件。',
        results: '个插件', more: '更多操作', dismiss: '关闭提示', loadFailed: '无法加载插件',
        stale: '当前显示上次加载的列表。刷新后可查看远端最新状态。',
        pendingBuilds: '构建脚本需要批准', approveBuilds: '批准构建并安装', cancel: '取消',
        buildMessage: '这些脚本将在远端主机运行。批准后，远端 profile 将永久允许这些脚本运行。请只批准你信任的脚本。',
        installDone: '插件安装完成。', operationDone: '远端插件已更新。', partialFailure: '插件操作未全部完成。',
        restartRequired: '重启远端 Host 后，变更才会生效。', notApplied: '变更尚未应用。请先检查远端 profile，再决定是否重试。',
        removeTitle: '卸载远端插件', removeMessage: '从远端 profile 移除此插件，不修改本地 profile。',
        confirmRemove: '从远端卸载', errorCode: '错误码', requestFailed: '插件操作失败。',
      },
    };

    const API_ROOT = '/api/ssh-remote';

    function object(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function text(...values) {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }
      return '';
    }

    function strings(value) {
      if (!Array.isArray(value)) return [];
      return [...new Set(value.map((item) => text(item)).filter(Boolean))];
    }

    function statusError(input, fallback) {
      const raw = object(input);
      const nested = object(raw.error);
      const error = new Error(text(nested.message, nested.diagnostic, typeof input === 'string' ? input : '', typeof raw.error === 'string' ? raw.error : '', raw.message, raw.diagnostic, fallback));
      error.code = text(nested.code, raw.code, 'REQUEST_FAILED');
      error.phase = text(nested.phase, nested.stage, raw.phase);
      return error;
    }

    function normalizeRemoteStatus(value, config = {}) {
      const raw = object(value);
      return {
        ok: raw.ok !== false,
        role: text(raw.role, 'remote'),
        hostAlias: text(raw.hostAlias, config.hostAlias, 'SSH'),
        dshVersion: text(raw.dshVersion, config.dshVersion),
      };
    }

    function isLoopbackUrl(value) {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
      } catch {
        return false;
      }
    }

    function returnToLocal(config, assign) {
      if (!isLoopbackUrl(config?.localReturnUrl)) throw statusError({ code: 'INVALID_RETURN_URL', message: 'The local return address is unavailable.' });
      try {
        assign(config.localReturnUrl);
      } catch {
        throw statusError({ code: 'NAVIGATION_FAILED', message: 'The local address could not be opened.' });
      }
      return null;
    }

    async function request(fetchImpl, path, options = {}) {
      let response;
      try {
        response = await fetchImpl(`${API_ROOT}${path}`, {
          method: options.method ?? 'POST', credentials: 'same-origin',
          headers: { accept: 'application/json', ...options.body !== undefined ? { 'content-type': 'application/json' } : {} },
          ...options.body !== undefined ? { body: JSON.stringify(options.body) } : {},
        });
      } catch (error) {
        throw statusError(error, 'The remote request failed.');
      }
      let value;
      try { value = await response.json(); }
      catch { throw statusError({ code: 'INVALID_RESPONSE', message: 'The remote response is invalid.' }); }
      if (!response.ok || (value?.ok === false && !options.allowFailure)) throw statusError(value, `HTTP ${response.status}`);
      return value;
    }

    function fetchRemoteStatus(fetchImpl) {
      return request(fetchImpl, '/status', { method: 'GET' });
    }

    function createPluginApi(fetchImpl) {
      return {
        page: () => request(fetchImpl, '/plugins/page', { body: {} }),
        install: (plugin, options = {}) => request(fetchImpl, '/plugins/install', {
          body: {
            spec: pluginInstallSpec(plugin), requestId: options.requestId,
            ...options.approvedBuilds?.length ? { approvedBuilds: strings(options.approvedBuilds) } : {},
            ...plugin.registry !== undefined && plugin.registry !== '' ? { registry: plugin.registry } : {},
          },
          allowFailure: true,
        }),
        setEnabled: (plugin, enabled) => request(fetchImpl, '/plugins/set-enabled', { body: { name: plugin.name, enabled: enabled === true }, allowFailure: true }),
        remove: (plugin) => request(fetchImpl, '/plugins/remove', { body: { name: plugin.name }, allowFailure: true }),
      };
    }

    function localized(value) {
      if (typeof value === 'string') return text(value);
      const raw = object(value);
      const first = Object.values(raw).find((item) => typeof item === 'string' && item.trim());
      return text(raw.en, raw.zh, raw.default, first);
    }

    function normalizePlugin(value, origin) {
      const raw = object(value);
      const meta = object(raw.meta);
      const name = text(raw.name, raw.packageName, raw.id, raw.spec);
      const spec = text(raw.spec, raw.installSpec, raw.packageName, raw.name);
      return {
        name, spec,
        title: localized(raw.title) || localized(meta.title) || text(name, spec),
        description: localized(raw.description) || localized(meta.description),
        version: text(raw.version, raw.expectedVersion),
        enabled: raw.enabled !== false && raw.disabled !== true,
        installed: raw.installed !== false,
        removable: raw.removable !== false,
        availability: text(raw.availability),
        official: raw.official === true || raw.builtin === true || raw.builtIn === true || raw.source === 'official' || name.startsWith('@deepseek-ai/') || spec.startsWith('@deepseek-ai/') || ['dsh-workspace-shell', 'dsh-workspace-shell-status'].includes(name),
        pendingBuilds: strings(raw.pendingBuilds),
        registry: typeof raw.registry === 'string' || raw.registry === null ? raw.registry : '',
        origin,
      };
    }

    function normalizePluginPage(value) {
      const raw = object(value);
      const local = raw.local?.bundles ?? raw.localSnapshot?.bundles ?? raw.localPlugins ?? (Array.isArray(raw.local) ? raw.local : []);
      const remote = raw.remote ?? raw.remotePlugins ?? raw.bundles ?? [];
      return {
        local: (Array.isArray(local) ? local : []).map((plugin) => normalizePlugin(plugin, 'local')).filter((plugin) => plugin.name && !plugin.official),
        remote: (Array.isArray(remote) ? remote : []).map((plugin) => normalizePlugin(plugin, 'remote')).filter((plugin) => plugin.name),
      };
    }

    function pluginInstallSpec(plugin) {
      const spec = text(plugin.spec, plugin.name);
      if (!spec || !plugin.version || spec.lastIndexOf('@') > 0) return spec;
      return `${spec}@${plugin.version}`;
    }

    function normalizePluginOutcome(value) {
      const raw = object(value);
      const result = object(raw.result ?? raw);
      const pendingBuilds = strings(result.pendingBuilds ?? raw.pendingBuilds);
      const items = (Array.isArray(result.items) ? result.items : Array.isArray(raw.items) ? raw.items : []).map((value) => {
        const item = object(value);
        return { name: text(item.name, item.spec, item.id), ok: item.ok !== false && !item.error, code: text(object(item.error).code, item.code), message: text(object(item.error).message, typeof item.error === 'string' ? item.error : '', item.message) };
      });
      const application = text(result.application, raw.application);
      const failed = raw.ok === false || result.ok === false || ['failed', 'cancelled'].includes(application) || items.some((item) => !item.ok);
      const partial = failed || pendingBuilds.length > 0;
      return {
        ok: !partial, partial, pendingBuilds, application, items,
        error: failed ? statusError(raw.error ?? result.error ?? raw, 'The plugin operation failed.') : null,
      };
    }

    function requestId() {
      return globalThis.crypto?.randomUUID?.() ?? `ssh-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    const EMBEDDED_KEY = 'ssh-remote:embedded';
    function detectEmbedded(pageWindow) {
      let marked = false;
      try { marked = new URL(pageWindow.location.href).searchParams.get('sshRemoteEmbedded') === '1'; } catch { /* No page URL in non-browser renders. */ }
      // Store only the page-mode bit, never an authenticated address or profile configuration.
      try {
        if (marked) pageWindow.sessionStorage.setItem(EMBEDDED_KEY, '1');
        return marked || pageWindow.sessionStorage.getItem(EMBEDDED_KEY) === '1';
      } catch { return marked; }
    }

    function filterPlugins(plugins, query) {
      const terms = text(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      return plugins.filter((plugin) => {
        const haystack = [plugin.title, plugin.name, plugin.description, plugin.version].join(' ').toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    function localInstallState(plugin, remote) {
      if (!plugin.installed || plugin.availability === 'missing') return 'missing';
      const installed = remote.find((item) => item.installed && item.name === plugin.name);
      if (!installed) return 'available';
      if (plugin.version && installed.version && plugin.version !== installed.version) return 'versionConflict';
      return installed.enabled ? 'installed' : 'enable';
    }

    const styles = `
      .ssh-rs { color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:1.5; box-sizing:border-box; }
      .ssh-rs *, .ssh-rs *::before, .ssh-rs *::after { box-sizing:border-box; }
      .ssh-rs-page { width:100%; height:100%; min-height:0; overflow:auto; padding:calc(var(--dsh-frame-top-clearance, 0px) + 24px) 28px 28px; }
      .ssh-rs-content { max-width:1060px; margin:0 auto; }
      .ssh-rs-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:24px; }
      .ssh-rs-heading { margin:0; font-size:22px; line-height:1.3; font-weight:650; letter-spacing:-.02em; }
      .ssh-rs-subtitle { margin:6px 0 0; color:var(--dsw-alias-label-secondary); max-width:620px; }
      .ssh-rs-host { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary); margin-bottom:8px; overflow-wrap:anywhere; }
      .ssh-rs-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
      .ssh-rs-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:30px; padding:5px 11px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; line-height:1.35; font-weight:500; cursor:pointer; white-space:nowrap; -webkit-app-region:no-drag; }
      .ssh-rs-button:hover:not(:disabled) { background:var(--dsw-alias-button-ghost-active-fill); }
      .ssh-rs-button-primary, .ssh-rs-button-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-fill); border-color:transparent; color:var(--dsw-alias-label-primary-inverted); }
      .ssh-rs-button-danger { color:var(--dsw-alias-state-error-primary); }
      .ssh-rs-button-ghost { border-color:transparent; background:transparent; }
      .ssh-rs-button-icon { width:30px; padding:5px; }
      .ssh-rs-button:disabled { opacity:.48; cursor:not-allowed; }
      .ssh-rs :is(button,input):focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
      .ssh-rs-tabs { display:flex; gap:22px; border-bottom:1px solid var(--dsw-alias-border-l1); overflow-x:auto; }
      .ssh-rs-tab { position:relative; border:0; border-radius:0; background:transparent; padding:10px 0 12px; color:var(--dsw-alias-label-secondary); }
      .ssh-rs-tab[aria-selected=true] { color:var(--dsw-alias-label-primary); font-weight:600; }
      .ssh-rs-tab[aria-selected=true]::after { content:''; position:absolute; bottom:0; inset-inline:0; height:2px; background:var(--dsw-alias-state-business-primary); }
      .ssh-rs-count { font-size:11px; font-variant-numeric:tabular-nums; padding:1px 6px; border-radius:4px; background:var(--dsw-alias-button-ghost-active-fill); color:var(--dsw-alias-label-secondary); }
      .ssh-rs-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 0; }
      .ssh-rs-search { display:flex; align-items:center; gap:8px; width:min(100%, 380px); min-width:0; padding:0 8px 0 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); }
      .ssh-rs-search input { width:100%; min-width:0; border:0; padding:8px 0; color:var(--dsw-alias-label-primary); background:transparent; font:inherit; }
      .ssh-rs-search input::placeholder { color:var(--dsw-alias-label-secondary); }
      .ssh-rs-search input::-webkit-search-cancel-button { display:none; }
      .ssh-rs-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .ssh-rs-snapshot { margin:0 0 14px; color:var(--dsw-alias-label-secondary); font-size:12px; }
      .ssh-rs-list { list-style:none; padding:0; margin:0; border-top:1px solid var(--dsw-alias-border-l1); }
      .ssh-rs-row { display:flex; align-items:center; gap:14px; padding:15px 2px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .ssh-rs-plugin-icon { display:grid; place-items:center; width:36px; height:36px; flex-shrink:0; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); }
      .ssh-rs-row-copy { min-width:0; flex:1; }
      .ssh-rs-row-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .ssh-rs-row-title h3 { font:inherit; font-weight:600; margin:0; overflow-wrap:anywhere; }
      .ssh-rs-package { display:block; color:var(--dsw-alias-label-secondary); font-size:11px; overflow-wrap:anywhere; }
      .ssh-rs-description { margin:4px 0 0; color:var(--dsw-alias-label-secondary); font-size:12px; overflow-wrap:anywhere; }
      .ssh-rs-badge { font-size:11px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0 5px; white-space:nowrap; }
      .ssh-rs-enabled { color:var(--dsw-alias-state-business-primary); }
      .ssh-rs-row-actions { min-width:125px; justify-content:flex-end; }
      .ssh-rs-overflow { position:relative; }
      .ssh-rs-menu { position:absolute; z-index:3; inset-inline-end:0; top:calc(100% + 4px); min-width:180px; padding:4px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
      .ssh-rs-menu .ssh-rs-button { width:100%; justify-content:flex-start; border:0; }
      .ssh-rs-feedback { display:flex; gap:12px; align-items:flex-start; padding:12px 14px; margin:0 0 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-layer-1); }
      .ssh-rs-feedback-copy { flex:1; min-width:0; overflow-wrap:anywhere; }
      .ssh-rs-feedback p { margin:3px 0 0; }
      .ssh-rs-feedback ul { margin:6px 0 0; padding-inline-start:18px; }
      .ssh-rs-feedback-error { border-inline-start:3px solid var(--dsw-alias-state-error-primary); }
      .ssh-rs-feedback-warning { border-inline-start:3px solid var(--dsw-alias-state-business-primary); }
      .ssh-rs-empty { display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; padding:48px 20px; }
      .ssh-rs-empty h2 { margin:0; font-size:15px; font-weight:600; }
      .ssh-rs-empty p { margin:0; max-width:440px; color:var(--dsw-alias-label-secondary); }
      .ssh-rs-spinner { display:inline-block; width:14px; height:14px; border:2px solid currentColor; border-inline-end-color:transparent; border-radius:50%; animation:ssh-rs-spin .8s linear infinite; flex-shrink:0; }
      .ssh-rs-dialog { width:min(460px, calc(100% - 40px)); max-height:calc(100% - 48px); overflow:auto; padding:24px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
      .ssh-rs-dialog::backdrop { background:color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent); }
      .ssh-rs-dialog h2 { font-size:17px; margin:0 0 12px; }
      .ssh-rs-dialog p { margin:8px 0; color:var(--dsw-alias-label-secondary); }
      .ssh-rs-dialog code, .ssh-rs-dialog li { overflow-wrap:anywhere; }
      .ssh-rs-dialog .ssh-rs-actions { justify-content:flex-end; margin-top:24px; flex-wrap:wrap; }
      .ssh-rs-status { display:inline-flex; align-items:center; gap:8px; font-size:12px; min-width:0; }
      .ssh-rs-status-label { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); }
      .ssh-rs-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
      @keyframes ssh-rs-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion:reduce) { .ssh-rs-spinner { animation:none; } }
      @media (max-width:640px) {
        .ssh-rs-page { padding-inline:16px; }
        .ssh-rs-header { flex-wrap:wrap; gap:14px; margin-bottom:16px; }
        .ssh-rs-tabs { gap:18px; }
        .ssh-rs-toolbar { flex-wrap:wrap; gap:8px; }
        .ssh-rs-search { width:100%; }
        .ssh-rs-row { flex-wrap:wrap; gap:10px; }
        .ssh-rs-row-actions { width:100%; padding-inline-start:46px; }
      }
    `;

    function Icon({ name = 'plugin', size = 18 }) {
      const paths = {
        plugin: 'M9 3h6v5h5v8h-5v5H9v-5H4V8h5Z',
        search: 'M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
        refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
        back: 'M19 12H5m6-6-6 6 6 6',
        close: 'm6 6 12 12M6 18 18 6',
        server: 'M4 4h16v6H4Zm0 10h16v6H4ZM7 7h.01M7 17h.01',
        more: 'M5 12h.01M12 12h.01M19 12h.01',
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 3 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] || paths.plugin }));
    }

    function PluginIcon({ size = 20 }) { return h(Icon, { size }); }
    function Spinner() { return h('span', { className: 'ssh-rs-spinner', 'aria-hidden': true }); }
    function Button({ kind = 'secondary', icon, loading = false, className = '', children, buttonRef, ...props }) {
      return h('button', { type: 'button', ...props, ref: buttonRef, 'aria-busy': loading || undefined,
        className: `ssh-rs-button ssh-rs-button-${kind} ${className}` },
      loading ? h(Spinner) : icon ? h(Icon, { name: icon, size: 15 }) : null, children);
    }

    function ReturnLocal({ embedded, config, t, onError }) {
      if (embedded) return null;
      const canReturn = isLoopbackUrl(config.localReturnUrl);
      return h(Button, { icon: 'back', disabled: !canReturn, title: t(canReturn ? 'title' : 'noReturnUrl'), onClick: () => {
        try { returnToLocal(config, (url) => window.location.assign(url)); }
        catch (error) { onError(statusError(error, t('navigationFailed'))); }
      } }, t('back'));
    }

    function Feedback({ notice, t, onDismiss, action }) {
      if (!notice) return null;
      return h('section', { role: notice.kind === 'error' ? 'alert' : 'status', className: `ssh-rs-feedback ssh-rs-feedback-${notice.kind || 'info'}`, 'aria-atomic': true },
        h('div', { className: 'ssh-rs-feedback-copy' },
          h('strong', null, notice.message),
          notice.detail ? h('p', null, notice.detail) : null,
          notice.error ? h('p', null, notice.error.message, h('span', { className: 'ssh-rs-package' }, `${t('errorCode')}: ${notice.error.code}`)) : null,
          notice.items?.length ? h('ul', null, notice.items.map((item, index) => h('li', { key: index }, `${item.name || item.code}: ${item.message || item.code}`))) : null),
        action,
        onDismiss ? h(Button, { kind: 'ghost', icon: 'close', className: 'ssh-rs-button-icon', 'aria-label': t('dismiss'), title: t('dismiss'), onClick: onDismiss }) : null);
    }

    function EmptyState({ title, detail, action, loading }) {
      return h('div', { className: 'ssh-rs-empty', role: 'status' },
        loading ? h(Spinner) : h(Icon, { size: 28 }), h('h2', null, title), detail ? h('p', null, detail) : null, action);
    }

    function Overflow({ plugin, disabled, onRemove, t }) {
      const [open, setOpen] = useState(false);
      const trigger = useRef(null);
      const menu = useRef(null);
      useEffect(() => { if (open) menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus(); }, [open]);
      const close = () => { setOpen(false); trigger.current?.focus(); };
      return h('div', { className: 'ssh-rs-overflow', onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }, onKeyDown: (event) => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) setOpen(true);
          else menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
        }
      } },
      h(Button, { kind: 'ghost', icon: 'more', className: 'ssh-rs-button-icon', buttonRef: trigger, disabled,
        'aria-label': `${t('more')}: ${plugin.title}`, title: `${t('more')}: ${plugin.title}`, 'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen((value) => !value) }),
      open ? h('div', { role: 'menu', ref: menu, className: 'ssh-rs-menu', 'aria-label': `${t('more')}: ${plugin.title}` },
        h(Button, { role: 'menuitem', kind: 'danger', onClick: () => { close(); onRemove(plugin); } }, t('remove'))) : null);
    }

    function PluginRow({ plugin, remote, busy, onInstall, onToggle, onRemove, t }) {
      const local = plugin.origin === 'local';
      const availability = local ? localInstallState(plugin, remote) : '';
      const installing = busy === `install:${plugin.name}`;
      const updating = busy === `toggle:${plugin.name}`;
      const removing = busy === `remove:${plugin.name}`;
      const installable = ['available', 'enable'].includes(availability);
      const installedRemote = local ? remote.find((item) => item.installed && item.name === plugin.name) : null;
      const localAction = installing ? 'installing' : updating ? 'working' : availability === 'available' ? 'install' : availability;
      return h('li', { className: 'ssh-rs-row', 'aria-label': plugin.title, 'aria-busy': installing || updating || removing || undefined },
        h('span', { className: 'ssh-rs-plugin-icon' }, h(PluginIcon)),
        h('div', { className: 'ssh-rs-row-copy' },
          h('div', { className: 'ssh-rs-row-title' }, h('h3', null, plugin.title),
            plugin.version ? h('span', { className: 'ssh-rs-meta' }, plugin.version) : null,
            plugin.official ? h('span', { className: 'ssh-rs-badge' }, t('official')) : null,
            !local ? h('span', { className: `ssh-rs-badge ${plugin.enabled ? 'ssh-rs-enabled' : ''}` }, t(plugin.enabled ? 'enabled' : 'disabled')) : null),
          h('code', { className: 'ssh-rs-package' }, plugin.name),
          plugin.description ? h('p', { className: 'ssh-rs-description' }, plugin.description) : null,
          availability === 'versionConflict' ? h('p', { className: 'ssh-rs-description' }, t('versionConflictHint')) : null,
          plugin.pendingBuilds.length ? h('p', { className: 'ssh-rs-description' }, t('pendingBuilds'), ': ', plugin.pendingBuilds.join(', ')) : null),
        h('div', { className: 'ssh-rs-actions ssh-rs-row-actions' },
          local ? h(Button, { kind: installable ? 'primary' : 'secondary', loading: installing || updating,
            'aria-label': `${t(localAction)}: ${plugin.title}`,
            disabled: Boolean(busy) || !installable,
            onClick: () => availability === 'enable' ? onToggle(installedRemote) : onInstall(plugin) },
          t(localAction)) : null,
          !local ? h(Button, { kind: plugin.enabled ? 'secondary' : 'primary', loading: updating || removing,
            'aria-label': `${t(updating || removing ? 'working' : plugin.enabled ? 'disable' : 'enable')}: ${plugin.title}`,
            disabled: Boolean(busy), onClick: () => onToggle(plugin) }, t(updating || removing ? 'working' : plugin.enabled ? 'disable' : 'enable')) : null,
          !local && plugin.removable ? h(Overflow, { plugin, disabled: Boolean(busy), onRemove, t }) : null,
          !local && !plugin.removable ? h('span', { className: 'ssh-rs-sr' }, t('protectedPlugin')) : null));
    }

    function ConfirmationDialog({ dialog, busy, onCancel, onConfirm, fallbackFocus, t }) {
      const element = useRef(null);
      const cancel = useRef(null);
      useEffect(() => {
        const node = element.current;
        if (!node) return undefined;
        const previous = node.ownerDocument.activeElement;
        node.showModal();
        return () => { node.close(); if (previous?.isConnected) previous.focus(); else fallbackFocus?.(); };
      }, []);
      const challenge = JSON.stringify([dialog.kind, dialog.plugin.name, dialog.builds || []]);
      useEffect(() => {
        if (!busy) cancel.current?.focus();
      }, [busy, challenge]);
      const removing = dialog.kind === 'remove';
      return h('dialog', { ref: element, className: 'ssh-rs ssh-rs-dialog', role: 'alertdialog', 'aria-modal': true,
        'aria-labelledby': 'ssh-rs-confirm-title', 'aria-describedby': 'ssh-rs-confirm-description', 'aria-busy': busy || undefined,
        onCancel: (event) => { event.preventDefault(); if (!busy) onCancel(); },
        onKeyDown: (event) => { if (event.key === 'Escape') event.stopPropagation(); } },
      h('h2', { id: 'ssh-rs-confirm-title' }, t(removing ? 'removeTitle' : 'pendingBuilds')),
      h('code', null, dialog.plugin.name),
      h('p', { id: 'ssh-rs-confirm-description' }, t(removing ? 'removeMessage' : 'buildMessage')),
      !removing ? h('ul', null, dialog.builds.map((build) => h('li', { key: build }, h('code', null, build)))) : null,
      h('div', { className: 'ssh-rs-actions' },
        h(Button, { buttonRef: cancel, disabled: busy, onClick: onCancel }, t('cancel')),
        h(Button, { kind: removing ? 'danger' : 'primary', loading: busy, disabled: busy, onClick: onConfirm }, t(busy ? 'working' : removing ? 'confirmRemove' : 'approveBuilds'))));
    }

    function PluginManagerPage({ t, config, embedded = false }) {
      const api = useRef(null);
      if (!api.current) api.current = createPluginApi(fetch);
      const [state, setState] = useState({ loading: true, loaded: false, snapshot: false, page: { local: [], remote: [] }, error: null });
      const [tab, setTab] = useState('remote');
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [dialog, setDialog] = useState(null);
      const sequence = useRef(0);
      const mounted = useRef(false);
      const fetching = useRef(false);
      const operation = useRef(false);
      const dialogRef = useRef(dialog);
      const searchInput = useRef(null);
      dialogRef.current = dialog;

      const refresh = useCallback(async (background = false) => {
        if (fetching.current) return;
        const current = ++sequence.current;
        fetching.current = true;
        if (!background) setState((value) => ({ ...value, loading: true, error: null }));
        try {
          const value = await api.current.page();
          if (mounted.current && current === sequence.current) setState({ loading: false, loaded: true,
            snapshot: Boolean(value.local ?? value.localSnapshot ?? value.localPlugins), page: normalizePluginPage(value), error: null });
        } catch (error) {
          if (mounted.current && current === sequence.current) setState((value) => ({ ...value, loading: false, error: statusError(error, t('requestFailed')) }));
        } finally { if (current === sequence.current) fetching.current = false; }
      }, [t]);

      useEffect(() => {
        mounted.current = true;
        void refresh();
        const timer = setInterval(() => {
          if (!operation.current && !dialogRef.current && !document.hidden) void refresh(true);
        }, 15_000);
        return () => { mounted.current = false; sequence.current += 1; fetching.current = false; clearInterval(timer); };
      }, [refresh]);

      const run = useCallback(async (kind, plugin, builds = []) => {
        if (operation.current) return;
        operation.current = true;
        // Invalidate a read that started before this mutation so it cannot restore stale rows.
        sequence.current += 1; fetching.current = false;
        setBusy(`${kind}:${plugin.name}`); setNotice(null);
        let closeDialog = false;
        try {
          const result = kind === 'install'
            ? await api.current.install(plugin, { requestId: requestId(), approvedBuilds: builds })
            : kind === 'toggle' ? await api.current.setEnabled(plugin, !plugin.enabled) : await api.current.remove(plugin);
          if (!mounted.current) return;
          const outcome = normalizePluginOutcome(result);
          if (outcome.pendingBuilds.length && kind === 'install') {
            setDialog({ kind: 'builds', plugin, builds: outcome.pendingBuilds });
            setNotice({ kind: 'warning', message: t('pendingBuilds') });
          } else {
            closeDialog = true;
            const unapplied = outcome.application === 'not-applied';
            setNotice({ kind: !outcome.ok ? 'error' : unapplied || outcome.application === 'restart-required' ? 'warning' : 'info',
              message: t(!outcome.ok ? 'partialFailure' : unapplied ? 'notApplied' : kind === 'install' ? 'installDone' : 'operationDone'),
              detail: outcome.application === 'restart-required' ? t('restartRequired') : '',
              error: outcome.error, items: outcome.items.filter((item) => !item.ok) });
          }
          await refresh(true);
        } catch (error) {
          if (mounted.current) {
            closeDialog = true;
            setNotice({ kind: 'error', message: t('requestFailed'), error: statusError(error, t('requestFailed')) });
            await refresh(true);
          }
        } finally {
          operation.current = false;
          if (mounted.current) {
            setBusy('');
            if (closeDialog) setDialog(null);
          }
        }
      }, [refresh, t]);

      const selectTab = (next) => { setTab(next); setQuery(''); };
      const remote = state.page.remote.filter((plugin) => plugin.installed);
      const plugins = tab === 'remote' ? remote : state.page.local;
      const visible = filterPlugins(plugins, query);
      const loadNotice = state.error ? { kind: 'error', message: t('loadFailed'), error: state.error, detail: state.loaded ? t('stale') : '' } : null;
      const locked = state.loading || Boolean(busy);
      const empty = query.trim() ? ['noMatches', 'noMatchesHint'] : tab === 'remote' ? ['noRemotePlugins', 'noRemoteHint']
        : !state.snapshot ? ['noSnapshot', 'noSnapshotHint'] : ['noLocalPlugins', 'noLocalHint'];

      return h('div', { className: 'ssh-rs ssh-rs-page' }, h('style', null, styles),
        h('div', { className: 'ssh-rs-content' },
          h('header', { className: 'ssh-rs-header' },
            h('div', null,
              h('div', { className: 'ssh-rs-host' }, h(Icon, { name: 'server', size: 14 }), text(config.hostAlias, 'SSH'), config.dshVersion ? ` · ${config.dshVersion}` : ''),
              h('h1', { className: 'ssh-rs-heading' }, t('pluginsTitle')), h('p', { className: 'ssh-rs-subtitle' }, t('pluginsSubtitle'))),
            h('div', { className: 'ssh-rs-actions' },
              h(Button, { icon: 'refresh', loading: state.loading, disabled: locked, onClick: () => void refresh() }, t(state.loading ? 'refreshing' : 'refresh')),
              h(ReturnLocal, { embedded, config, t, onError: (error) => setNotice({ kind: 'error', message: t('navigationFailed'), error }) }))),
          h(Feedback, { notice: loadNotice, t, action: h(Button, { disabled: locked, onClick: () => void refresh() }, t('retry')) }),
          h(Feedback, { notice, t, onDismiss: () => setNotice(null) }),
          h('div', { role: 'tablist', 'aria-label': t('pluginsTitle'), className: 'ssh-rs-tabs' },
            ['remote', 'local'].map((name) => h(Button, { key: name, role: 'tab', id: `ssh-rs-tab-${name}`, className: 'ssh-rs-tab',
              'aria-selected': tab === name, 'aria-controls': `ssh-rs-panel-${name}`, tabIndex: tab === name ? 0 : -1,
              onClick: () => selectTab(name), onKeyDown: (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 'remote' : event.key === 'End' ? 'local' : name === 'remote' ? 'local' : 'remote';
                selectTab(next);
                event.currentTarget.parentElement.querySelector(`#ssh-rs-tab-${next}`)?.focus();
              } }, t(name === 'remote' ? 'remotePlugins' : 'localPlugins'), state.loaded ? h('span', { className: 'ssh-rs-count' }, name === 'remote' ? remote.length : state.page.local.length) : null))),
          h('div', { className: 'ssh-rs-toolbar' },
            h('div', { className: 'ssh-rs-search' }, h(Icon, { name: 'search', size: 16 }),
              h('label', { className: 'ssh-rs-sr', htmlFor: 'ssh-rs-search' }, t('search')),
              h('input', { ref: searchInput, id: 'ssh-rs-search', type: 'search', value: query, placeholder: t('searchPlaceholder'), onChange: (event) => setQuery(event.target.value), 'aria-controls': `ssh-rs-panel-${tab}` }),
              query ? h(Button, { icon: 'close', kind: 'ghost', className: 'ssh-rs-button-icon', 'aria-label': t('clearSearch'), title: t('clearSearch'), onClick: () => setQuery('') }) : null),
            h('span', { className: 'ssh-rs-meta', role: 'status', 'aria-live': 'polite' }, state.loaded ? `${visible.length} / ${plugins.length} ${t('results')}` : t('loading'))),
          h('section', { role: 'tabpanel', hidden: true, id: `ssh-rs-panel-${tab === 'remote' ? 'local' : 'remote'}`, 'aria-labelledby': `ssh-rs-tab-${tab === 'remote' ? 'local' : 'remote'}` }),
          h('section', { role: 'tabpanel', id: `ssh-rs-panel-${tab}`, 'aria-labelledby': `ssh-rs-tab-${tab}`, 'aria-busy': state.loading, tabIndex: 0 },
            tab === 'local' ? h('p', { className: 'ssh-rs-snapshot' }, t('snapshotHint')) : null,
            !state.loaded ? (state.loading ? h(EmptyState, { loading: true, title: t('loading') }) : null)
              : visible.length ? h('ul', { className: 'ssh-rs-list', 'aria-label': t(tab === 'remote' ? 'remoteLive' : 'localSnapshot') },
                visible.map((plugin) => h(PluginRow, { key: `${plugin.name}@${plugin.version}`, plugin, remote, busy: locked ? busy || 'refresh' : '', t,
                  onInstall: (item) => void run('install', item), onToggle: (item) => void run('toggle', item), onRemove: (item) => setDialog({ kind: 'remove', plugin: item }) })))
                : h(EmptyState, { title: t(empty[0]), detail: t(empty[1]), action: query.trim()
                  ? h(Button, { onClick: () => setQuery('') }, t('clearSearch'))
                  : tab === 'remote' ? h(Button, { onClick: () => selectTab('local') }, t('browseLocal')) : null }))),
        dialog ? h(ConfirmationDialog, { dialog, busy: Boolean(busy), t, fallbackFocus: () => searchInput.current?.focus(), onCancel: () => { setDialog(null); setNotice(null); },
          onConfirm: () => void run(dialog.kind === 'remove' ? 'remove' : 'install', dialog.plugin, dialog.builds) }) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx, config) {
        for (const locale of ['en', 'zh']) ctx.effect(() => ctx.locale.register('ssh-remote-status', locale, messages[locale]));
        const t = ctx.locale.bind('ssh-remote-status');
        const embedded = detectEmbedded(window);
        function RemoteStatus() {
          const [state, setState] = useState({ loading: true, value: normalizeRemoteStatus(null, config), error: null });
          useEffect(() => {
            let active = true;
            fetchRemoteStatus(fetch).then((value) => {
              if (active) setState({ loading: false, value: normalizeRemoteStatus(value, config), error: null });
            }).catch((error) => {
              if (active) setState((current) => ({ ...current, loading: false, error: statusError(error, t('unavailable')) }));
            });
            return () => { active = false; };
          }, []);
          return h('div', { className: 'ssh-rs ssh-rs-status' }, h('style', null, styles),
            state.loading ? h(Spinner) : h(Icon, { name: 'server', size: 14 }),
            h('span', { className: 'ssh-rs-status-label', title: `${t('workspace')} · ${state.value.hostAlias} · ${t('version')} ${state.value.dshVersion || t('unavailable')}` },
              `${t('remote')}: ${state.value.hostAlias}${state.value.dshVersion ? ` · ${state.value.dshVersion}` : ''}`),
            state.loading ? h('span', { className: 'ssh-rs-sr', role: 'status' }, t('checking')) : null,
            state.error ? h('span', { role: 'alert', title: state.error.code }, t('unavailable')) : null,
            h(ReturnLocal, { embedded, config, t, onError: (error) => setState((current) => ({ ...current, error })) }));
        }
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'ssh-remote-status', order: -20, label: () => t('remote'),
        }, RemoteStatus));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'ssh-remote-plugins', order: 3, label: () => t('pluginsPage'),
        }, PluginIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'ssh-remote-plugins', label: () => t('pluginsPage'),
        }, () => h(PluginManagerPage, { t, config, embedded })));
      },
      __test: {
        normalizeRemoteStatus, returnToLocal, fetchRemoteStatus, isLoopbackUrl, statusError,
        createPluginApi, normalizePlugin, normalizePluginPage, pluginInstallSpec, normalizePluginOutcome,
        detectEmbedded, filterPlugins, localInstallState, PluginManagerPage, PluginRow, ReturnLocal,
        Button, Overflow, ConfirmationDialog, Feedback, messages, styles,
      },
    };
  },
});
