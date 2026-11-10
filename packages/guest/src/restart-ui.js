// Restart surface for a Guest Web Host: one sidebar footer action and one
// settings row, both driving the Host's own restart routes. Modelled on
// dsh-restart-now's product behaviour (confirm, wait-for-idle, force, receipt)
// with one addition that only makes sense for a Web Host: after the restart the
// page polls its own origin and reloads itself, because a same-port restart
// keeps the login cookie valid.

const STATUS_PATH = '/api/workspace-host/status';
const RESTART_PATH = '/api/workspace-host/restart';
const ID = 'workspace-restart';
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 60_000;

const MESSAGES = {
  zh: {
    label: '重启此 Host',
    title: '重启此 Host',
    body: '重启会关闭当前 Web Host 并自动拉起。正在运行的任务会中断。',
    restart: '重启',
    force: '立即重启',
    wait: '等空闲后重启',
    cancel: '取消',
    busy: (tasks, jobs) => `还有 ${tasks} 个任务、${jobs} 个后台作业在运行。`,
    restarting: '正在重启，等待 Host 回来…',
    supervised: '这个 Host 由 supervisor 管理，请在所在页签或管理页重启。',
    disabled: '此 profile 关闭了重启。',
    cooldown: '刚刚重启过，请稍等几秒。',
    failed: (code) => `重启失败：${code}`,
    stale: '端口可能已变化，新地址见终端输出或工作区页签。',
    last: (receipt) => (receipt?.ok ? '上次重启：成功' : `上次重启：失败（${receipt?.error ?? 'unknown'}）`),
  },
  en: {
    label: 'Restart this Host',
    title: 'Restart this Host',
    body: 'The Web Host closes and comes back on its own. Running work is interrupted.',
    restart: 'Restart',
    force: 'Restart now',
    wait: 'Wait until idle',
    cancel: 'Cancel',
    busy: (tasks, jobs) => `${tasks} task(s) and ${jobs} job(s) are still running.`,
    restarting: 'Restarting — waiting for the Host to come back…',
    supervised: 'This Host is supervised; restart it from its tab or manager page.',
    disabled: 'Restart is disabled for this profile.',
    cooldown: 'Restarted just now — try again in a few seconds.',
    failed: (code) => `Restart failed: ${code}`,
    stale: 'The port may have changed; take the new URL from the terminal or the workspace tab.',
    last: (receipt) => (receipt?.ok ? 'Last restart: succeeded' : `Last restart: failed (${receipt?.error ?? 'unknown'})`),
  },
};

function dictionaryFor(document) {
  const lang = String(document?.documentElement?.getAttribute?.('lang') ?? '').toLowerCase();
  return lang.startsWith('en') ? MESSAGES.en : MESSAGES.zh;
}

const style = {
  panel: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2147483000 },
  card: { width: 'min(420px, 90vw)', background: 'var(--dsh-surface, #1f2430)', color: 'var(--dsh-text, #e6e8ee)', borderRadius: '12px', padding: '18px 20px', boxShadow: '0 18px 48px rgba(0,0,0,0.45)', font: '13px/1.6 system-ui, sans-serif' },
  title: { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 },
  text: { margin: '0 0 14px', opacity: 0.85 },
  row: { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' },
  button: { border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', font: 'inherit' },
  primary: { border: '1px solid transparent', background: 'var(--dsh-accent, #4f7cff)', color: '#fff', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', font: 'inherit' },
};

/**
 * @param {object} React React runtime provided by the client bundle.
 * @param {{window: Window, document: Document}} deps
 */
export function createGuestRestart(React, deps = {}) {
  const window = deps.window;
  const document = deps.document;
  const t = dictionaryFor(document);
  const disposers = [];
  let disposed = false;
  let reloadTimer = null;
  let reloadUntil = 0;

  const noop = () => {};

  async function call(path, body) {
    const response = await window.fetch(path, body === undefined ? { credentials: 'same-origin', cache: 'no-store' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.ok !== true) {
      const code = payload?.code ?? `HTTP_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    return payload;
  }

  function pollForRecovery() {
    reloadUntil = Date.now() + POLL_LIMIT_MS;
    const tick = async () => {
      if (disposed) return;
      try {
        const response = await window.fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          // The server answers before its plugin bundles have finished booting;
          // reloading on the first 200 gives a blank page. Give it a moment.
          window.setTimeout(() => window.location.reload(), 1_200);
          return;
        }
      } catch { /* Host is still down */ }
      if (Date.now() < reloadUntil) reloadTimer = window.setTimeout(tick, POLL_MS);
    };
    reloadTimer = window.setTimeout(tick, POLL_MS);
  }

  function ConfirmOverlay({ onClose }) {
    const [state, setState] = React.useState({ phase: 'loading', status: null, message: '' });
    React.useEffect(() => {
      let cancelled = false;
      call(STATUS_PATH).then((payload) => {
        if (cancelled) return;
        if (payload.supervised) setState({ phase: 'blocked', status: payload, message: t.supervised });
        else if (payload.allowRestart === false) setState({ phase: 'blocked', status: payload, message: t.disabled });
        else setState({ phase: 'ready', status: payload, message: '' });
      }, (error) => { if (!cancelled) setState({ phase: 'blocked', status: null, message: t.failed(error.code ?? 'unavailable') }); });
      return () => { cancelled = true; };
    }, []);
    const restart = (mode, force) => {
      setState((current) => ({ ...current, phase: 'sending', message: '' }));
      call(RESTART_PATH, { mode, force }).then(() => {
        setState((current) => ({ ...current, phase: 'restarting', message: t.restarting }));
        pollForRecovery();
      }, (error) => setState((current) => ({ ...current, phase: 'ready', message: t.failed(error.code ?? 'unavailable') })));
    };
    const busy = (state.status?.busy?.tasks ?? 0) + (state.status?.busy?.jobs ?? 0) > 0;
    const rows = [];
    if (state.phase === 'ready' && busy) {
      rows.push(React.createElement('button', { key: 'wait', style: style.button, onClick: () => restart('wait', false) }, t.wait));
      rows.push(React.createElement('button', { key: 'force', style: style.primary, onClick: () => restart('now', true) }, t.force));
    } else if (state.phase === 'ready') {
      rows.push(React.createElement('button', { key: 'now', style: style.primary, onClick: () => restart('now', false) }, t.restart));
    }
    rows.push(React.createElement('button', { key: 'cancel', style: style.button, onClick: onClose }, t.cancel));
    const busyText = busy ? t.busy(state.status.busy.tasks, state.status.busy.jobs) : '';
    return React.createElement('div', { style: style.panel, role: 'dialog', 'aria-modal': 'true', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
      React.createElement('div', { style: style.card },
        React.createElement('h3', { style: style.title }, t.title),
        React.createElement('p', { style: style.text }, state.message || busyText || t.body),
        state.status?.lastRestart ? React.createElement('p', { style: { ...style.text, opacity: 0.6 } }, t.last(state.status.lastRestart)) : null,
        React.createElement('div', { style: style.row }, ...rows)));
  }

  function FooterAction() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button', title: t.label, 'aria-label': t.label,
        style: { ...style.button, padding: '4px 8px', lineHeight: 1 },
        onClick: () => setOpen(true),
      }, '\u27f3'),
      open ? React.createElement(ConfirmOverlay, { onClose: () => setOpen(false) }) : null);
  }

  function SettingsRow() {
    const [open, setOpen] = React.useState(false);
    const [note, setNote] = React.useState('');
    React.useEffect(() => {
      call(STATUS_PATH).then((payload) => {
        if (payload.supervised) setNote(t.supervised);
        else if (payload.allowRestart === false) setNote(t.disabled);
        else if (payload.lastRestart) setNote(t.last(payload.lastRestart));
      }, () => noop());
    }, []);
    return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 0' } },
      React.createElement('div', null,
        React.createElement('div', null, t.label),
        note ? React.createElement('div', { style: { opacity: 0.6, fontSize: '12px' } }, note) : null),
      React.createElement('button', { type: 'button', style: style.button, onClick: () => setOpen(true) }, t.restart),
      open ? React.createElement(ConfirmOverlay, { onClose: () => setOpen(false) }) : null);
  }

  function register(slots) {
    const inject = (name, register) => {
      try {
        disposers.push(slots.inject(name, () => register()));
      } catch { /* an older Host without this slot simply gets no entry */ }
    };
    inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: ID, order: 120, label: t.label }, FooterAction));
    inject('settings.general.item', () => slots.register({ name: 'settings.general.item', id: ID, order: 92 }, SettingsRow));
  }

  return Object.freeze({
    apply(ctx) {
      if (disposed) return;
      let slots = null;
      try { slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined; } catch { slots = null; }
      if (slots) { register(slots); return; }
      try { ctx?.inject?.(['slots'], (scope) => register((scope && scope.slots) || (scope && scope.get && scope.get('slots')))); } catch { /* no slots, no entry */ }
    },
    dispose() {
      disposed = true;
      if (reloadTimer !== null) { try { window.clearTimeout(reloadTimer); } catch { /* already gone */ } reloadTimer = null; }
      const list = disposers.splice(0, disposers.length);
      for (const dispose of list) { try { if (typeof dispose === 'function') dispose(); } catch { /* keep disposing */ } }
    },
  });
}
