// Launcher page: a real workspace tab, not a modal. The component owns only UI
// state; every effect goes through the injected workspace client, and every
// conversion preserves the tab ID/position through `launcher.replace`.
const MAX_COMMAND_LENGTH = 4096;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_PATH_LENGTH = 4096;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ACTIVE_PHASES = ['starting', 'running', 'stopping'];
const EMPTY_TIMING = Object.freeze({ entries: Object.freeze([]) });
const EMPTY_LIST = Object.freeze([]);
const FALLBACK_TIMING = Object.freeze({ getSnapshot: () => EMPTY_TIMING, subscribe: () => () => {} });

// Parses a TUI command into argv without a shell. This mirrors the Host parser so
// obvious mistakes are rejected before a process is requested, and keeps the
// input bounded (length, arguments, control characters).
export function parseTuiCommand(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, code: 'TUI_COMMAND_EMPTY' };
  if (value.length > MAX_COMMAND_LENGTH) return { ok: false, code: 'TUI_COMMAND_TOO_LONG' };
  if (/[\0\r\n]/u.test(value)) return { ok: false, code: 'TUI_COMMAND_INVALID' };
  const argv = [];
  let part = '';
  let started = false;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && quote !== "'") {
      if (index + 1 >= value.length) return { ok: false, code: 'TUI_COMMAND_INVALID_ESCAPE' };
      part += value[++index];
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else part += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (!started) continue;
      argv.push(part);
      part = '';
      started = false;
      if (argv.length > MAX_COMMAND_ARGUMENTS) return { ok: false, code: 'TUI_COMMAND_TOO_MANY_ARGS' };
      continue;
    }
    part += character;
    started = true;
  }
  if (quote) return { ok: false, code: 'TUI_COMMAND_UNCLOSED_QUOTE' };
  if (started) argv.push(part);
  if (!argv.length) return { ok: false, code: 'TUI_COMMAND_EMPTY' };
  if (argv.length > MAX_COMMAND_ARGUMENTS) return { ok: false, code: 'TUI_COMMAND_TOO_MANY_ARGS' };
  return { ok: true, argv };
}

export function parseTuiCwd(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, code: 'TUI_CWD_EMPTY' };
  const cwd = value.trim();
  if (cwd.length > MAX_PATH_LENGTH || cwd.includes('\u0000') || /[\r\n]/u.test(cwd)) return { ok: false, code: 'TUI_CWD_INVALID' };
  if (!ABSOLUTE_PATH.test(cwd)) return { ok: false, code: 'TUI_CWD_NOT_ABSOLUTE' };
  return { ok: true, cwd };
}

function launcherCopy(english) {
  return english ? {
    title: 'New workspace', sources: 'Sources', local: 'This device', sshGroup: 'SSH connections',
    sshEmpty: 'No saved SSH connections.', connected: 'Connected', disconnected: 'Not connected', profiles: 'Local profiles', profileLoading: 'Reading local profiles…',
    profileEmpty: 'No other usable local profile.', profileError: 'The profile list could not be refreshed. Showing the last known list.',
    profileUnknown: 'Unrecognized', profileMixed: 'Web/TUI',
    refresh: 'Refresh', open: 'Open workspace', web: 'Web', tui: 'TUI', browser: 'Browser', browserSoon: 'Not available yet',
    chooseKind: 'Workspace type', cwd: 'Working directory', cwdPlaceholder: 'Absolute project directory',
    command: 'Launch command', commandHint: 'Parsed into an executable and arguments; it never goes through a shell.',
    hosts: 'Running Web Hosts', hostsEmpty: 'No Web Host is running.', hostsStale: 'This list may be out of date.',
    views: 'views', newView: 'New view', waitStart: 'Waiting for the Host to start', stopping: 'Stopping',
    heldByOther: 'Owned by another window', stop: 'Stop Host', status: 'Status', source: 'Source',
    confirmStop: 'Stopping this Host interrupts its Agents, terminals, and background tasks. Web views sharing this Host close; other Hosts are unaffected. Stop it?',
    cancel: 'Cancel',
    close: 'Close tab', timing: 'Recent open timings', timingEmpty: 'No measurement yet.', timingReused: 'reused Host',
    timingNew: 'new Host', stageInput: 'input', stageConnect: 'SSH connect', stageInstance: 'instance', stageForward: 'forward',
    stageHost: 'Host wait', stageLease: 'lease', stageLoad: 'load', total: 'total', failed: 'failed',
    busyOpening: 'Opening…', busyClosing: 'Closing views…', staleTab: 'This launcher tab was replaced. Retry or close it.',
    tuiEmptyCwd: 'Enter the project directory used for this terminal.', tuiEmptyCommand: 'Enter a launch command.',
    tuiBadCommand: 'The command is invalid: check quotes, escapes, line breaks, and length.',
    tuiBadCwd: 'Enter an absolute directory without line breaks.', dismiss: 'Dismiss',
    unavailableWeb: 'Web workspaces need the Native window or a browser Guest.',
    unavailableTui: 'The terminal input-isolation contract is unavailable.',
    reuse: 'Reuses the Web Host started by this window.', closeNote: 'Closing a Web tab releases only its view. Closing a TUI tab stops that instance.',
    emptyTitle: 'Choose a source', emptyBody: 'Pick a local profile or an SSH connection to open a workspace.',
    sshHint: 'SSH only supports Web workspaces on loopback forwarding.', loading: 'Loading…',
  } : {
    title: '新建工作区', sources: '来源', local: '本机', sshGroup: 'SSH 连接',
    sshEmpty: '还没有保存的 SSH 连接。', connected: '已连接', disconnected: '未连接', profiles: '本机 profile', profileLoading: '正在读取本机 profile…',
    profileEmpty: '没有其它可用的本机 profile。', profileError: 'profile 列表读取失败，显示的是上次结果。',
    profileUnknown: '未识别', profileMixed: 'Web/TUI',
    refresh: '刷新', open: '打开工作区', web: 'Web', tui: 'TUI', browser: 'Browser', browserSoon: '暂未开放',
    chooseKind: '工作区类型', cwd: '工作目录', cwdPlaceholder: '输入项目目录的绝对路径',
    command: '启动命令', commandHint: '命令会解析为可执行文件和参数，不经过 shell。',
    hosts: '运行中的 Web Host', hostsEmpty: '当前没有运行中的 Web Host。', hostsStale: '可能不是最新。',
    views: '个视图', newView: '新建视图', waitStart: '等待 Host 启动', stopping: '正在停止',
    heldByOther: '由其它窗口持有', stop: '停止 Host', status: '状态', source: '来源',
    confirmStop: '停止所选 Host 实例会中断该实例内的 Agent、终端和后台任务；共用此 Host 的 Web 视图会关闭，其它 Host 不受影响。确认停止？',
    cancel: '取消',
    close: '关闭页签', timing: '最近打开耗时', timingEmpty: '还没有测量记录。', timingReused: '复用 Host',
    timingNew: '新建 Host', stageInput: '输入', stageConnect: 'SSH 连接', stageInstance: '实例', stageForward: '转发',
    stageHost: 'Host 等待', stageLease: 'lease', stageLoad: '加载', total: '总耗时', failed: '失败',
    busyOpening: '正在打开…', busyClosing: '正在关闭视图…', staleTab: '该 launcher 页签已被替换，请重试或关闭。',
    tuiEmptyCwd: '请输入该终端使用的工作目录。', tuiEmptyCommand: '请输入启动命令。',
    tuiBadCommand: '命令无效：请检查引号、转义、换行和长度。',
    tuiBadCwd: '请输入不含换行的绝对路径。', dismiss: '关闭提示',
    unavailableWeb: 'Web 工作区需要 Native 主窗口或浏览器 Guest。',
    unavailableTui: 'TUI 输入隔离契约当前不可用。',
    reuse: '复用本窗口已启动的 Web Host。', closeNote: 'Web 关闭页签只关闭视图，Host 继续运行；TUI 关闭页签会同时停止其实例。',
    emptyTitle: '选择来源', emptyBody: '选择本机 profile 或 SSH 连接来打开工作区。',
    sshHint: 'SSH 只支持回环转发上的 Web 工作区。', loading: '正在加载…',
  };
}

export const launcherCss = [
  '.wsh-launcher{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;min-width:0;padding:16px 20px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden}',
  '.wsh-launcher-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none;min-width:0}',
  '.wsh-launcher-heading-wrap{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.wsh-launcher-title{font-size:18px;line-height:1.3;margin:0;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.wsh-launcher-subtitle{font-size:11px}',
  '.wsh-launcher-header-actions{display:flex;gap:6px;flex:none}',
  '.wsh-launcher-status{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.wsh-launcher-status[data-status-kind=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
  '.wsh-launcher-status-text{min-width:0;overflow-wrap:anywhere}',
  '.wsh-launcher-body{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:16px;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden}',
  '.wsh-launcher-sidebar{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding-right:4px;border-right:1px solid var(--dsw-alias-border-l3)}',
  '.wsh-launcher-sources{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.wsh-launcher-source-caption{margin:8px 0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}',
  '.wsh-launcher-source{display:flex;align-items:baseline;justify-content:space-between;gap:8px;width:100%;font:inherit;font-size:13px;text-align:left;color:inherit;background:transparent;border:1px solid transparent;border-radius:6px;padding:7px 9px;cursor:pointer;min-width:0}',
  '.wsh-launcher-source:hover{background:color-mix(in srgb,currentColor 7%,transparent)}',
  '.wsh-launcher-source[aria-selected=true]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-button-ghost-active-fill);font-weight:500}',
  '.wsh-launcher-source-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wsh-launcher-source-detail{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wsh-launcher-source-dot{align-self:center;width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
  '.wsh-launcher-source-dot[data-connected=true]{background:var(--dsw-alias-state-success-primary)}',
  '.wsh-launcher-content{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px}',
  '.wsh-launcher-pane{display:flex;flex-direction:column;gap:12px;min-width:0}',
  '.wsh-launcher-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}',
  '.wsh-launcher-section-heading{font-size:13px;font-weight:600;margin:0}',
  '.wsh-launcher-profile-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;min-width:0}',
  '.wsh-launcher-profile{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left}',
  '.wsh-launcher-profile-name{font-size:12px;font-weight:500}',
  '.wsh-launcher-profile-kind{font-size:11px}',
  '.wsh-launcher-panel-host{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
  '.wsh-launcher-badge{align-self:center;font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
  '.wsh-launcher-panel{display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.wsh-launcher-field{max-width:560px}',
  '.wsh-launcher-actions{display:flex;justify-content:flex-end;gap:8px}',
  '.wsh-launcher-actions .wsh-primary{font-weight:600;border-color:var(--dsw-alias-brand-primary)}',
  '.wsh-launcher-kind{display:flex;align-items:center;gap:6px;min-width:96px}',
  '.wsh-kind-choice{display:flex;flex-wrap:wrap;gap:6px}',
  '.wsh-launcher-hosts{display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.wsh-host-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-width:0}',
  '.wsh-host-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
  '.wsh-host-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.wsh-host-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wsh-host-meta{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wsh-host-actions{display:flex;gap:6px;flex:none}',
  '.wsh-launcher-empty{display:flex;align-items:center;gap:10px;padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px}',
  '.wsh-launcher-spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:wsh-launcher-spin 900ms linear infinite}',
  '@keyframes wsh-launcher-spin{to{transform:rotate(360deg)}}',
  '.wsh-launcher-empty-message{margin:0}',
  '.wsh-timing{flex:none;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wsh-timing>summary{cursor:pointer;padding:4px 0;color:var(--dsw-alias-label-primary)}',
  '.wsh-timing-list{list-style:none;margin:0;padding:4px 0 0;display:flex;flex-direction:column;gap:3px;max-height:140px;overflow:auto;min-width:0}',
  '.wsh-timing-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}',
  '.wsh-timing-row[data-status=failed]{color:var(--dsw-alias-state-error-primary)}',
  '.wsh-timing-stages{display:inline-flex;flex-wrap:wrap;gap:6px}',
  '.wsh-timing-stage{white-space:nowrap}',
  '.wsh-timing-total{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
  '.wsh-launcher-field input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
  '.wsh-field-error{color:var(--dsw-alias-state-error-primary);font-size:11px}',
  '.wsh-error-slot{display:flex;align-items:center;gap:4px;min-width:0;flex:none}',
  '.wsh-error-dismiss{padding:1px 6px}',
  '.wsh-tabstrip-host{display:flex;flex:1 1 auto;min-width:0;height:100%}',
  '@media(max-width:820px){.wsh-launcher{padding:12px 14px}.wsh-launcher-body{grid-template-columns:minmax(140px,200px) minmax(0,1fr);gap:12px}}',
  '@media(max-width:640px){.wsh-launcher-body{grid-template-columns:minmax(0,1fr)}.wsh-launcher-sidebar{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l3);padding:0 0 8px;max-height:180px}.wsh-launcher-header-actions{flex-wrap:wrap}.wsh-launcher-profile-list{grid-template-columns:minmax(0,1fr)}.wsh-host-row{flex-direction:column;align-items:flex-start}.wsh-host-actions{width:100%;justify-content:flex-end}}',
  '@media(prefers-reduced-motion:reduce){.wsh-launcher-spinner{animation:none}}',
].join('\n');

export function createLauncher(React, deps = {}) {
  if (!React || typeof React.createElement !== 'function') throw new TypeError('createLauncher requires React');
  const h = React.createElement;
  const document = deps.document ?? globalThis.document;
  const initialLocale = deps.locale || document?.documentElement?.lang || 'zh';
  const copy = launcherCopy(!String(initialLocale).toLowerCase().startsWith('zh'));
  const safeCode = (value) => {
    let code;
    try { code = typeof value === 'string' ? value : value?.code; } catch {}
    return SAFE_CODE.test(code ?? '') ? code : 'WORKSPACE_ACTION_FAILED';
  };
  const describe = (code) => {
    const safe = safeCode(code);
    const known = {
      'TUI_COMMAND_EMPTY': copy.tuiEmptyCommand, 'TUI_COMMAND_INVALID': copy.tuiBadCommand,
      'TUI_COMMAND_INVALID_ESCAPE': copy.tuiBadCommand, 'TUI_COMMAND_UNCLOSED_QUOTE': copy.tuiBadCommand,
      'TUI_COMMAND_TOO_LONG': copy.tuiBadCommand, 'TUI_COMMAND_TOO_MANY_ARGS': copy.tuiBadCommand,
      'TUI_CWD_EMPTY': copy.tuiEmptyCwd, 'TUI_CWD_INVALID': copy.tuiBadCwd, 'TUI_CWD_NOT_ABSOLUTE': copy.tuiBadCwd,
      'INVALID_TUI_CWD': copy.tuiBadCwd, 'INVALID_TUI_COMMAND': copy.tuiBadCommand,
      'WORKSPACE_LAUNCHER_STALE': copy.staleTab,
    };
    return known[safe] ? `${known[safe]} [${safe}]` : safe;
  };
  const stageLabel = (stage) => {
    const names = {
      input: copy.stageInput, connect: copy.stageConnect, instance: copy.stageInstance, forward: copy.stageForward,
      host: copy.stageHost, lease: copy.stageLease, load: copy.stageLoad,
    };
    return Object.hasOwn(names, stage) ? names[stage] : null;
  };
  const duration = (value) => `${Math.max(0, Math.round(Number(value) || 0))}ms`;
  const flavorLabel = (flavor) => flavor === 'pi-tui' ? 'Pi TUI' : flavor === 'dsh-tui' ? 'DSH TUI' : copy.tui;
  const defaultCommand = (id) => `dsh --profile ${id}`;
  const profileLabel = (profile) => {
    if (!profile) return '';
    if (profile.web && !profile.tui) return copy.web;
    if (profile.tui && !profile.web) return flavorLabel(profile.tuiFlavor);
    if (profile.web && profile.tui) return copy.profileMixed;
    return copy.profileUnknown;
  };
  const sortProfiles = (profiles) => profiles.slice().sort((left, right) => {
    const rank = (item) => item.web ? 0 : item.tui ? 1 : 2;
    return rank(left) - rank(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });

  function Modal({ title, message, confirmLabel, busy, onCancel, onConfirm, confirmDisabled }) {
    const section = React.useRef(null);
    const confirmRef = React.useRef(null);
    React.useEffect(() => {
      const previous = document?.activeElement;
      try { confirmRef.current?.focus?.({ preventScroll: true }); } catch { /* Focus entry is best effort. */ }
      return () => {
        try { if (previous?.isConnected) previous.focus?.({ preventScroll: true }); } catch { /* Never steal focus from a newer dialog. */ }
      };
    }, []);
    const onKeyDown = (event) => {
      event.stopPropagation?.();
      if (event.key === 'Escape') { event.preventDefault?.(); onCancel(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(section.current?.querySelectorAll?.('button:not([disabled])') ?? [])];
      if (!items.length) return;
      const active = document?.activeElement;
      const index = items.indexOf(active);
      const next = event.shiftKey
        ? (index <= 0 ? items.length - 1 : index - 1)
        : (index === items.length - 1 || index < 0 ? 0 : index + 1);
      event.preventDefault?.();
      items[next]?.focus?.({ preventScroll: true });
    };
    return h('div', { className: 'wsh-sheet-backdrop' },
      h('section', { ref: section, className: 'wsh-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1, onKeyDown },
        h('div', { className: 'wsh-sheet-title' }, h('strong', null, title),
          h('button', { type: 'button', className: 'wsh-button', onClick: onCancel }, copy.cancel)),
        h('p', { className: 'wsh-warning' }, message),
        h('div', { className: 'wsh-sheet-actions' },
          h('button', { type: 'button', className: 'wsh-button', onClick: onCancel }, copy.cancel),
          h('button', { ref: confirmRef, type: 'button', className: 'wsh-button wsh-danger', disabled: Boolean(busy) || confirmDisabled === true, onClick: onConfirm }, confirmLabel))));
  }

  function Sources({ sources, selected, onSelect }) {
    const nodes = React.useRef(new Map());
    const select = (key) => {
      onSelect(key);
      try { nodes.current.get(key)?.focus?.({ preventScroll: true }); } catch { /* Focus is best effort. */ }
    };
    const onKeyDown = (event, index) => {
      if (event.key === 'ArrowDown') { event.preventDefault?.(); if (sources.length) select(sources[(index + 1) % sources.length].key); }
      else if (event.key === 'ArrowUp') { event.preventDefault?.(); if (sources.length) select(sources[(index - 1 + sources.length) % sources.length].key); }
      else if (event.key === 'Home') { event.preventDefault?.(); if (sources.length) select(sources[0].key); }
      else if (event.key === 'End') { event.preventDefault?.(); if (sources.length) select(sources[sources.length - 1].key); }
    };
    return h('div', { className: 'wsh-launcher-sources', role: 'listbox', 'aria-label': copy.sources, 'data-launcher-sources': '' },
      sources.map((item, index) => h('div', { key: item.key, className: 'wsh-launcher-source-group', 'data-source-group': item.group },
        item.group === 'ssh' && index === sources.findIndex((entry) => entry.group === 'ssh')
          ? h('p', { className: 'wsh-launcher-source-caption' }, copy.sshGroup) : null,
        h('button', {
          type: 'button', role: 'option', className: 'wsh-launcher-source',
          ref: (node) => { if (node) nodes.current.set(item.key, node); else nodes.current.delete(item.key); },
          id: `wsh-launcher-source-${encodeURIComponent(item.key)}`,
          'aria-selected': item.key === selected, 'data-source-key': item.key, 'data-source-kind': item.kind,
          tabIndex: item.key === selected ? 0 : -1,
          onClick: () => onSelect(item.key),
          onKeyDown: (event) => onKeyDown(event, index),
        },
          h('span', { className: 'wsh-launcher-source-label' }, item.label),
          typeof item.connected === 'boolean' ? h('span', { className: 'wsh-launcher-source-dot',
            'data-connected': String(item.connected), role: 'img',
            'aria-label': item.connected ? copy.connected : copy.disconnected,
            title: item.connected ? copy.connected : copy.disconnected }) : null,
          item.detail ? h('span', { className: 'wsh-launcher-source-detail' }, item.detail) : null))));
  }

  function KindChoice({ value, canWeb, canTui, onChange }) {
    const options = [
      { key: 'web', label: copy.web, disabled: !canWeb, note: canWeb ? null : copy.unavailableWeb },
      { key: 'tui', label: copy.tui, disabled: !canTui, note: canTui ? null : copy.unavailableTui },
      { key: 'browser', label: copy.browser, disabled: true, note: copy.browserSoon },
    ];
    return h('div', { className: 'wsh-kind-choice', role: 'radiogroup', 'aria-label': copy.chooseKind, 'data-launcher-kinds': '' },
      options.map((option) => h('button', {
        key: option.key, type: 'button', role: 'radio', className: 'wsh-choice wsh-launcher-kind',
        'aria-checked': value === option.key ? 'true' : 'false', disabled: option.disabled, 'data-kind': option.key,
        onClick: () => { if (!option.disabled) onChange(option.key); },
      }, h('span', null, option.label), option.note ? h('small', { className: 'wsh-muted' }, option.note) : null)));
  }

  function WebForm({ reusable, busy, canOpen, onOpen }) {
    return h('div', { className: 'wsh-launcher-panel', 'data-launcher-panel': 'web' },
      reusable ? h('p', { className: 'wsh-muted', 'data-launcher-reuse': '' }, copy.reuse) : null,
      h('p', { className: 'wsh-muted' }, copy.closeNote),
      h('div', { className: 'wsh-launcher-actions' },
        h('button', { type: 'button', className: 'wsh-button wsh-primary', disabled: busy || !canOpen,
          'data-launcher-action': 'open-web', onClick: onOpen }, busy ? copy.busyOpening : copy.open)));
  }

  function TuiForm({ cwd, command, cwdText, commandText, busy, onCwd, onCommand, onOpen }) {
    return h('form', {
      className: 'wsh-launcher-panel', 'data-launcher-panel': 'tui',
      onSubmit: (event) => { event.preventDefault?.(); onOpen(); },
    },
      h('label', { className: 'wsh-field wsh-launcher-field' }, copy.cwd,
        h('input', { value: cwd, required: true, spellCheck: false, autoComplete: 'off', placeholder: copy.cwdPlaceholder,
          'aria-invalid': cwdText ? 'true' : 'false', 'data-field': 'cwd',
          onChange: (event) => onCwd(event.target.value) }),
        cwdText ? h('small', { className: 'wsh-field-error', role: 'alert' }, cwdText) : null),
      h('label', { className: 'wsh-field wsh-launcher-field' }, copy.command,
        h('input', { value: command, required: true, spellCheck: false, autoComplete: 'off',
          'aria-invalid': commandText ? 'true' : 'false', 'data-field': 'command',
          onChange: (event) => onCommand(event.target.value) }),
        h('small', { className: 'wsh-muted' }, copy.commandHint),
        commandText ? h('small', { className: 'wsh-field-error', role: 'alert' }, commandText) : null),
      h('div', { className: 'wsh-launcher-actions' },
        h('button', { type: 'submit', className: 'wsh-button wsh-primary', disabled: busy || Boolean(cwdText) || Boolean(commandText),
          'data-launcher-action': 'open-tui' }, busy ? copy.busyOpening : copy.open)));
  }

  function ProfilePanel({ profile, choice, canWeb, canTui, info, busy, error, cwd, command, cwdText, commandText,
    onKind, onCwd, onCommand, onOpen, onRetry }) {
    const recognized = profile.web !== profile.tui;
    const kind = choice ?? (profile.web ? 'web' : profile.tui ? 'tui' : 'web');
    const choose = !recognized && (canWeb || canTui);
    const usable = kind === 'web' ? canWeb : kind === 'tui' ? canTui : false;
    const reusable = kind === 'web' && (Array.isArray(info.runtimes) ? info.runtimes : []).some((runtime) => runtime.kind === 'web'
      && runtime.source !== 'ssh' && runtime.profileId === profile.id && ['running', 'starting'].includes(runtime.phase));
    const hasError = Boolean(error);
    return h('section', { className: 'wsh-launcher-panel-host', 'data-launcher-profile': profile.id, 'data-recognized': recognized ? 'true' : 'false' },
      h('div', { className: 'wsh-launcher-section-title' },
        h('strong', null, profile.id),
        h('span', { className: 'wsh-launcher-badge' }, profileLabel(profile))),
      hasError ? h('p', { className: 'wsh-warning', role: 'alert', 'data-launcher-error': safeCode(error) },
        describe(error),
        h('button', { type: 'button', className: 'wsh-button', 'data-launcher-action': 'retry', onClick: onRetry }, copy.retry)) : null,
      !recognized && !canWeb && !canTui ? h('p', { className: 'wsh-muted' }, copy.unavailableWeb) : null,
      choose ? h(KindChoice, { value: kind, canWeb, canTui, onChange: onKind }) : null,
      !choose && kind === 'web' && !canWeb ? h('p', { className: 'wsh-muted' }, copy.unavailableWeb) : null,
      !choose && kind === 'tui' && !canTui ? h('p', { className: 'wsh-muted' }, copy.unavailableTui) : null,
      usable && kind === 'web' ? h(WebForm, { reusable, busy, canOpen: true, onOpen: () => onOpen('web') }) : null,
      usable && kind === 'tui' ? h(TuiForm, { cwd, command, cwdText, commandText, busy, onCwd, onCommand, onOpen: () => onOpen('tui') }) : null);
  }

  function HostList({ info, busy, onNewView, onStop, onRefresh }) {
    const runtimes = (Array.isArray(info.runtimes) ? info.runtimes : []).filter((runtime) => runtime.kind === 'web'
      && runtime.source !== 'ssh' && ACTIVE_PHASES.includes(runtime.phase));
    const stale = info.phase === 'error';
    return h('section', { className: 'wsh-launcher-hosts', 'data-launcher-hosts': '', 'aria-label': copy.hosts },
      h('div', { className: 'wsh-launcher-section-title' },
        h('strong', null, copy.hosts),
        h('button', { type: 'button', className: 'wsh-button', 'data-launcher-action': 'refresh', disabled: busy, onClick: onRefresh }, copy.refresh)),
      stale ? h('p', { className: 'wsh-warning', role: 'status', 'data-launcher-stale': '' }, copy.hostsStale) : null,
      runtimes.length
        ? h('ul', { className: 'wsh-host-list' }, runtimes.map((runtime) => {
          const owned = runtime.canStop === true;
          const canOpen = runtime.phase === 'running' && owned;
          const reason = runtime.phase === 'starting' ? copy.waitStart : runtime.phase === 'stopping' ? copy.stopping : !owned ? copy.heldByOther : copy.newView;
          return h('li', { key: runtime.id, className: 'wsh-host-row', 'data-runtime-id': runtime.id, 'data-phase': runtime.phase },
            h('div', { className: 'wsh-host-main' },
              h('strong', { className: 'wsh-host-title' }, runtime.profileId),
              h('span', { className: 'wsh-muted wsh-host-meta' },
                [copy.web, `${copy.source} ${copy.local}`, `${copy.status} ${runtime.phase}`, `${runtime.views ?? 0} ${copy.views}`].join(' · '))),
            h('div', { className: 'wsh-host-actions' },
              h('button', { type: 'button', className: 'wsh-button', disabled: busy || !canOpen, title: reason,
                'data-launcher-action': 'new-view', onClick: () => onNewView(runtime) }, copy.newView),
              h('button', { type: 'button', className: 'wsh-button wsh-danger', disabled: busy || !owned, title: owned ? copy.stop : copy.heldByOther,
                'data-launcher-action': 'stop-host', onClick: () => onStop(runtime) }, copy.stop)));
        }))
        : h('p', { className: 'wsh-muted', 'data-launcher-empty': 'hosts' }, copy.hostsEmpty));
  }

  function Timing({ store }) {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
    return h('details', { className: 'wsh-timing', 'data-launcher-timing': '' },
      h('summary', null, copy.timing),
      entries.length
        ? h('ul', { className: 'wsh-timing-list' }, entries.map((entry) => h('li', {
          key: entry.id, className: 'wsh-timing-row', 'data-status': entry.status === 'failed' ? 'failed' : 'ready',
          'data-reused': entry.reused ? 'true' : 'false', 'data-measurement': entry.id,
        },
          h('span', { className: 'wsh-timing-source' }, entry.source === 'ssh' ? copy.sshGroup : copy.local),
          entry.profile ? h('span', { className: 'wsh-timing-profile' }, entry.profile) : null,
          entry.status === 'failed' ? h('span', { className: 'wsh-warning' }, `${copy.failed} ${safeCode(entry.code)}`) : null,
          h('span', { className: 'wsh-timing-stages' }, (entry.stages ?? []).map((stage) => {
            const label = stageLabel(stage.stage);
            return label ? h('span', { key: stage.stage, className: 'wsh-timing-stage', 'data-stage': stage.stage }, `${label} ${duration(stage.at)}`) : null;
          })),
          h('span', { className: 'wsh-timing-total' }, `${copy.total} ${duration(entry.totalMs)}`),
          entry.kind === 'web' ? h('span', { className: 'wsh-muted' }, entry.reused ? copy.timingReused : copy.timingNew) : null)))
        : h('p', { className: 'wsh-muted' }, copy.timingEmpty));
  }

  function Launcher(props) {
    const { tabId, workspace, info, connections, ssh, localCwd, onClose, onError, onModalChange } = props;
    const [source, setSource] = React.useState('local');
    const [profileId, setProfileId] = React.useState('');
    const [choice, setChoice] = React.useState(null);
    const [cwd, setCwd] = React.useState('');
    const [command, setCommand] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [notice, setNotice] = React.useState(null);
    const [confirm, setConfirm] = React.useState(null);
    const cwdDirty = React.useRef(false);
    const commandDirty = React.useRef(false);
    const live = React.useRef(true);
    React.useEffect(() => () => { live.current = false; }, []);
    // Report modal ownership without re-running on every parent render: only a
    // real change (dialog opened/closed or the callback identity moved) fires.
    const modalOpen = Boolean(confirm);
    const reportedModal = React.useRef(null);
    React.useEffect(() => {
      if (reportedModal.current === onModalChange && modalOpen === reportedModal.open) return undefined;
      reportedModal.current = onModalChange; reportedModal.open = modalOpen;
      onModalChange?.(modalOpen);
      return () => { if (reportedModal.current === onModalChange) reportedModal.current = null; };
    }, [modalOpen, onModalChange]);
    const connectionList = ssh && Array.isArray(connections) ? connections : EMPTY_LIST;
    const sources = React.useMemo(() => {
      const local = { key: 'local', group: 'local', kind: 'local', label: copy.local, detail: info.currentProfile || null };
      const remote = connectionList.map((entry) => ({
        key: `ssh:${entry.id}`, group: 'ssh', kind: 'ssh', label: entry.name,
        connected: entry.connected === true,
      }));
      if (ssh && !remote.length) remote.push({ key: 'ssh:new', group: 'ssh', kind: 'ssh', label: copy.sshGroup });
      return [local, ...remote];
    }, [connectionList, info.currentProfile, ssh]);
    const sourceExists = sources.some((item) => item.key === source);
    React.useEffect(() => { if (!sourceExists) setSource('local'); }, [sourceExists]);
    const profileList = Array.isArray(info.profiles) ? info.profiles : EMPTY_LIST;
    const profiles = React.useMemo(() => sortProfiles(profileList
      .filter((item) => !item.isCurrent && item.id !== info.currentProfile && item.id !== 'desktop' && item.id !== 'headless')), [profileList, info.currentProfile]);
    React.useEffect(() => {
      if (!profiles.length) { if (profileId) setProfileId(''); return; }
      if (!profiles.some((item) => item.id === profileId)) setProfileId(profiles[0].id);
    }, [profiles, profileId]);
    const profile = profiles.find((item) => item.id === profileId) ?? null;
    // Reset per-profile form state only when the selected profile actually changes.
    // `profile` is a fresh object each render, so its identity may not be the key.
    React.useEffect(() => {
      setChoice(null);
      if (!profile) { setCommand(''); return; }
      commandDirty.current = false;
      setCommand(defaultCommand(profile.id));
    }, [profileId]);
    // One recorded source directory per launcher identity; late answers never
    // overwrite edited input or a converted tab (readLauncherCwd revalidates).
    React.useEffect(() => {
      let current = true;
      if (!workspace || typeof workspace.readLauncherCwd !== 'function') return () => { current = false; };
      Promise.resolve().then(() => workspace.readLauncherCwd(tabId, localCwd ?? null)).then((value) => {
        if (!current || !live.current || cwdDirty.current) return;
        if (typeof value === 'string' && value.trim()) setCwd(value);
      }, () => {});
      return () => { current = false; };
    }, [tabId, workspace, localCwd]);
    const cwdCheck = parseTuiCwd(cwd);
    const commandCheck = parseTuiCommand(command);
    const cwdText = cwd && !cwdCheck.ok ? copy.tuiBadCwd : null;
    const commandText = command && !commandCheck.ok ? copy.tuiBadCommand : null;
    const kind = choice ?? (profile?.web ? 'web' : profile?.tui ? 'tui' : 'web');
    const run = async (action) => {
      if (busy) return false;
      setBusy(true); setError(null); setNotice(null); onError?.(null);
      try { return await action(); }
      catch (cause) { if (live.current) setError(safeCode(cause)); return false; }
      finally { if (live.current) setBusy(false); }
    };
    const openWeb = () => run(async () => {
      if (!profile) return;
      await workspace.openLauncherWeb(tabId, { profileId: profile.id });
    });
    const openTui = () => run(async () => {
      if (!profile) return;
      const path = parseTuiCwd(cwd);
      if (!path.ok) { setError(path.code); return; }
      const line = parseTuiCommand(command);
      if (!line.ok) { setError(line.code); return; }
      const override = commandDirty.current ? command.trim() : undefined;
      await workspace.openLauncherTui(tabId, { profileId: profile.id, cwd: path.cwd, ...(override ? { command: override } : {}) });
    });
    const newView = (runtime) => run(async () => { await workspace.openLauncherWeb(tabId, { profileId: runtime.profileId, runtimeId: runtime.id }); });
    const refresh = () => run(() => workspace.refresh());
    const confirmStop = () => {
      const runtime = confirm?.runtime;
      if (!runtime) return;
      setConfirm(null);
      void run(async () => {
        try { await workspace.stopRuntime(runtime.id); }
        catch (cause) { if (live.current) setError(safeCode(cause)); }
      });
    };
    const toast = error ?? notice;
    const remote = sources.find((item) => item.key === source && item.group === 'ssh');
    const remoteEntry = remote ? (Array.isArray(connections) ? connections : []).find((entry) => `ssh:${entry.id}` === remote.key) : null;
    const localPane = h('div', { className: 'wsh-launcher-pane', 'data-launcher-pane': 'local' },
      h('div', { className: 'wsh-launcher-section-title' },
        h('h2', { className: 'wsh-launcher-section-heading' }, copy.profiles),
        h('button', { type: 'button', className: 'wsh-button', 'data-launcher-action': 'refresh', disabled: busy, onClick: refresh }, copy.refresh)),
      info.phase === 'error' ? h('p', { className: 'wsh-warning' }, copy.profileError) : null,
      profiles.length
        ? h('div', { className: 'wsh-launcher-profile-list', role: 'radiogroup', 'aria-label': copy.profiles },
          profiles.map((item) => h('button', {
            key: item.id, type: 'button', role: 'radio', className: 'wsh-choice wsh-launcher-profile',
            'aria-checked': item.id === profileId ? 'true' : 'false', 'data-profile-id': item.id,
            disabled: busy, onClick: () => setProfileId(item.id),
          },
            h('span', { className: 'wsh-launcher-profile-name' }, item.id),
            h('span', { className: 'wsh-muted wsh-launcher-profile-kind' }, profileLabel(item)))))
        : h('div', { className: 'wsh-launcher-empty', 'data-launcher-empty': 'profiles' },
          h('strong', null, info.phase === 'loading' ? copy.profileLoading : copy.profileEmpty),
          info.phase === 'loading' ? h('span', { className: 'wsh-launcher-spinner', 'aria-hidden': 'true' }) : null),
      profile
        ? h(ProfilePanel, {
          profile, choice, canWeb: workspace.canWeb, canTui: workspace.canTui, info, busy, error,
          cwd, command, cwdText, commandText, onKind: setChoice,
          onCwd: (value) => { cwdDirty.current = true; setCwd(value); },
          onCommand: (value) => { commandDirty.current = true; setCommand(value); },
          onOpen: (type) => { void (type === 'web' ? openWeb() : openTui()); },
          onRetry: () => { void refresh(); },
        })
        : null,
      h(HostList, { info, busy, onNewView: (runtime) => { void newView(runtime); }, onStop: (runtime) => setConfirm({ type: 'stop', runtime }), onRefresh: refresh }));
    // The SSH component talks to the manager API through `api(path, input, signal)`.
    // The client exposes one origin-checked request surface for it; no URL, token,
    // or credential ever passes back through this prop.
    const sshApi = React.useCallback(
      (pathname, input, signal) => workspace.sshRequest(pathname, { body: input ?? {}, signal }),
      [workspace],
    );
    const sshPane = remote && ssh
      ? h('div', { className: 'wsh-launcher-pane', 'data-launcher-pane': 'ssh' },
        h('p', { className: 'wsh-muted' }, copy.sshHint),
        h(ssh, {
          api: sshApi,
          active: source !== 'local',
          locale: copy.title === '新建工作区' ? 'zh' : 'en',
          initialHostId: remoteEntry?.id ?? '',
          viewCounts: typeof workspace.sshViewCounts === 'function' ? workspace.sshViewCounts() : {},
          onOpenWeb: (host, url, meta) => workspace.openSshWeb(host, url, { ...meta, launcherId: tabId }),
          onStopWeb: (host, instanceId) => workspace.closeSshViews(host.id, instanceId),
          notify: (message) => {
            if (!live.current) return;
            const text = typeof message === 'string' ? message : typeof message?.message === 'string' ? message.message : null;
            setNotice(text);
          },
        }))
      : h('div', { className: 'wsh-launcher-empty', 'data-launcher-empty': 'ssh' }, h('strong', null, copy.sshEmpty));
    const dialog = confirm
      ? h(Modal, {
        title: copy.stop, message: copy.confirmStop, confirmLabel: copy.stop, busy,
        onCancel: () => setConfirm(null), onConfirm: confirmStop,
      })
      : null;
    return h('section', { className: 'wsh-launcher', role: 'group', 'data-launcher': 'root', 'data-source': source, 'data-tab-id': tabId },
      h('header', { className: 'wsh-launcher-header' },
        h('div', { className: 'wsh-launcher-heading-wrap' },
          h('h1', { className: 'wsh-launcher-title' }, copy.title),
          h('span', { className: 'wsh-muted wsh-launcher-subtitle' }, info.currentProfile ? `${copy.local} · ${info.currentProfile}` : copy.local)),
        h('div', { className: 'wsh-launcher-header-actions' },
          h('button', { type: 'button', className: 'wsh-button', 'data-launcher-action': 'close', disabled: busy, onClick: onClose }, copy.close))),
      toast ? h('div', { className: 'wsh-launcher-status', 'data-status-kind': error ? 'error' : 'notice', role: error ? 'alert' : 'status' },
        h('span', { className: 'wsh-launcher-status-text' }, error ? describe(error) : toast),
        h('button', { type: 'button', className: 'wsh-button', 'aria-label': copy.dismiss,
          onClick: () => { setError(null); setNotice(null); onError?.(null); } }, '×')) : null,
      h('div', { className: 'wsh-launcher-body' },
        h('aside', { className: 'wsh-launcher-sidebar' }, h(Sources, { sources, selected: source, onSelect: setSource })),
        h('div', { className: 'wsh-launcher-content', role: 'group', 'aria-label': `wsh-launcher-content-${source}` },
          h('p', { className: 'wsh-sr-only', role: 'status', 'aria-live': 'polite', 'data-launcher-live': '' }, busy ? copy.busyOpening : ''),
          source === 'local' ? localPane : sshPane)),
      h(Timing, { store: workspace.timing ?? FALLBACK_TIMING }),
      dialog);
  }

  return { Launcher, copy, css: launcherCss };
}


