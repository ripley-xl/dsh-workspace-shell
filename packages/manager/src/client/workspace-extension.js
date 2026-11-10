export function createSshRequest(fetcher, lifetime) {
  const getPaths = new Set(['/status', '/ssh-hosts']);
  const postPaths = new Set([
    '/hosts', '/connect', '/disconnect', '/sync/preview', '/sync', '/stop', '/interaction', '/ports', '/diagnostics',
    '/web/list', '/web/open', '/web/attach', '/web/stop', '/web/discovered', '/web/discovered/attach',
    '/web/discovered/stop', '/web/discovered/restart', '/web/discovered/sync', '/cleanup-runtime',
    '/upgrade', '/upgrade/approve',
  ]);
  const error = (code) => Object.assign(new Error(code), { code });
  return async (path, { body = {}, signal } = {}) => {
    if (!getPaths.has(path) && !postPaths.has(path)) throw error('WORKSPACE_INVALID_REQUEST');
    const combined = lifetime && signal ? AbortSignal.any([lifetime, signal]) : lifetime ?? signal;
    if (combined?.aborted) throw error('OPERATION_CANCELLED');
    const get = getPaths.has(path);
    let url = '/api/ssh-remote' + path;
    if (path === '/ssh-hosts' && typeof body.query === 'string') url += '?query=' + encodeURIComponent(body.query.trim().slice(0, 256));
    let response, value;
    try {
      response = await fetcher(url, {
        method: get ? 'GET' : 'POST', credentials: 'same-origin', signal: combined,
        headers: { accept: 'application/json', ...get ? {} : { 'content-type': 'application/json' } },
        ...get ? {} : { body: JSON.stringify(body) },
      });
      value = await response.json();
    } catch { throw error(combined?.aborted ? 'OPERATION_CANCELLED' : 'SSH_REMOTE_UNREACHABLE'); }
    if (combined?.aborted) throw error('OPERATION_CANCELLED');
    if (!response.ok || value?.ok === false) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(value?.error?.code) ? value.error.code : 'SSH_REMOTE_UNREACHABLE';
      throw error(code);
    }
    return value;
  };
}

export function createSshWorkspaceExtension(React, { window, document, createSshLauncher }) {
  const h = React.createElement;
  const lifetime = new AbortController();
  const rawRequest = createSshRequest(window.fetch.bind(window), lifetime.signal);
  const listeners = new Set();
  let state = Object.freeze({ connections: [], prompts: [] });
  let stopped = false, source, read = 0, sequence = 0;
  const connections = (value) => Object.freeze((Array.isArray(value) ? value : []).slice(0, 256)
    .filter((entry) => entry && typeof entry.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.id))
    .map((entry) => Object.freeze({ id: entry.id, name: [entry.name, entry.hostAlias, entry.id].find((name) => typeof name === 'string' && name.trim() && name.length <= 128),
      connected: typeof entry.connected === 'boolean' ? entry.connected : ['connected', 'ready', 'switching'].includes(entry.phase) })));
  const waiting = new Map();
  const publish = (value) => {
    if (stopped) return;
    state = Object.freeze(value);
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  };
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const getSnapshot = () => state;
  const removePrompt = (id) => publish({ ...state, prompts: state.prompts.filter((prompt) => prompt.id !== id) });
  const finish = (id, accepted) => {
    const pending = waiting.get(id);
    waiting.delete(id);
    pending?.resolve(accepted);
    removePrompt(id);
  };
  const ask = (prompt, signal) => {
    if (stopped || signal?.aborted) return Promise.resolve(false);
    const id = 'confirm-' + (++sequence);
    return new Promise((resolve) => {
      const abort = () => finish(id, false);
      const done = (value) => { signal?.removeEventListener('abort', abort); resolve(value); };
      waiting.set(id, { resolve: done });
      signal?.addEventListener('abort', abort, { once: true });
      publish({ ...state, prompts: [...state.prompts, { ...prompt, id }] });
    });
  };
  const refresh = async () => {
    const ticket = ++read;
    try {
      const value = await rawRequest('/status');
      if (stopped || ticket !== read) return;
      publish({ ...state, connections: connections(value.connections) });
    } catch { /* The launcher reports request failures; background reads retain the last snapshot. */ }
  };
  const request = async (path, options = {}) => {
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    // Each DSH version keeps its own remote Host instances; failures surface
    // unchanged instead of opening a confirmation prompt.
    const result = await rawRequest(path, { ...options, signal });
    if (path === '/connect' && result.sync && (result.sync.ok === false || result.sync.requiresMerge)) {
      const path = result.sync.requiresMerge && typeof result.sync.backup?.path === 'string' ? result.sync.backup.path.slice(0, 4096) : '';
      await ask({ kind: 'review', partial: result.sync.ok === false, path }, signal);
    }
    if (stopped || signal.aborted) throw Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' });
    if (path === '/status') { ++read; publish({ ...state, connections: connections(result.connections) }); }
    else if (['/connect', '/disconnect', '/hosts'].includes(path)) void refresh();
    return result;
  };
  const ui = createSshLauncher(React, { document, window, api: (path, body, signal) => request(path, { body, signal }) });
  const words = {
    en: { close: 'Close', cancel: 'Cancel', busy: 'Working', continue: 'Continue', trust: 'Verify SSH host key', auth: 'SSH authentication', submit: 'Submit', accept: 'Trust and connect', review: 'Connection synchronization', partial: 'Some configuration could not be synchronized. The remote Host is available.', backup: 'Remote configuration backup requires review:', password: 'Password or key passphrase' },
    zh: { close: '关闭', cancel: '取消', busy: '处理中', continue: '继续', trust: '校验 SSH 主机密钥', auth: 'SSH 认证', submit: '提交', accept: '信任并连接', review: '连接同步结果', partial: '部分配置未同步成功，远端 Host 仍可使用。', backup: '远端配置备份需要检查：', password: '密码或密钥口令' },
  };
  function Prompt({ prompt, t }) {
    const form = React.useRef(null);
    const pending = React.useRef(false);
    const alive = React.useRef(true);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const clear = (node = form.current) => {
      for (const input of [...(node?.querySelectorAll?.('input') ?? [])]) input.value = '';
    };
    React.useEffect(() => {
      const node = form.current;
      return () => { alive.current = false; clear(node); };
    }, []);
    const interaction = prompt.kind === 'interaction';
    const hostKey = interaction && prompt.request.kind === 'host-key';
    const answer = async (cancel = false, trusted = false) => {
      if (pending.current) return;
      if (!interaction) { finish(prompt.id, !cancel); return; }
      pending.current = true; setBusy(true); setError('');
      const values = [...(form.current?.querySelectorAll?.('input') ?? [])].map((input) => input.value);
      clear();
      const data = { requestId: prompt.request.requestId, ...cancel ? { cancel: true } : hostKey ? { trusted } : ['keyboardInteractive', 'keyboard-interactive'].includes(prompt.request.kind) ? { responses: values } : { value: values[0] ?? '' } };
      try { await rawRequest('/interaction', { body: data }); removePrompt(prompt.id); }
      catch (cause) { if (alive.current) setError(cause.code); }
      finally {
        values.fill(''); delete data.value; delete data.responses;
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    };
    const title = t(interaction ? hostKey ? 'trust' : 'auth' : prompt.kind);
    return h(ui.Dialog, { title, busy, onClose: () => void answer(true), t },
      prompt.kind === 'review' ? h('div', null,
        prompt.partial ? h('p', { role: 'alert' }, t('partial')) : null,
        prompt.path ? h('p', null, t('backup'), h('code', null, prompt.path)) : null) : null,
      hostKey ? h('div', null, h('p', null, prompt.request.host), h('code', null, prompt.request.fingerprint)) : null,
      interaction && prompt.request.name ? h('strong', null, prompt.request.name) : null,
      interaction && prompt.request.instructions ? h('p', null, prompt.request.instructions) : null,
      h('form', { ref: form, onSubmit: (event) => { event.preventDefault(); void answer(false, hostKey); } },
        interaction && !hostKey ? (prompt.request.prompts.length ? prompt.request.prompts : [{ prompt: t('password') }]).map((item, index) => h(ui.Field, { key: index, label: item.prompt || t('password') }, h('input', { type: item.echo ? 'text' : 'password', autoComplete: 'off', disabled: busy }))) : null,
        error ? h('p', { role: 'alert' }, error) : null,
        h('footer', { className: 'wsh-ssh-dialog-footer' },
          h(ui.Button, { disabled: busy, 'data-autofocus': true, onClick: () => void answer(true) }, t(prompt.kind === 'review' ? 'close' : 'cancel')),
          prompt.kind !== 'review' ? h(ui.Button, { type: 'submit', disabled: busy || hostKey && !prompt.request.fingerprint, kind: 'primary' }, t(hostKey ? 'accept' : interaction ? 'submit' : 'continue')) : null)));
  }
  function Overlay({ onModalChange, locale: activeLocale }) {
    const current = React.useSyncExternalStore(subscribe, getSnapshot);
    const prompt = current.prompts.find((item) => item.kind === 'interaction') ?? current.prompts[0];
    const locale = String(activeLocale ?? document.documentElement?.lang ?? 'zh').startsWith('en') ? 'en' : 'zh';
    const t = (key) => words[locale][key] ?? key;
    React.useEffect(() => { onModalChange?.(Boolean(prompt)); return () => onModalChange?.(false); }, [Boolean(prompt), onModalChange]);
    return prompt ? h('div', { className: 'wsh-ssh', style: { position: 'absolute', inset: 0, zIndex: 70 } }, h(Prompt, { key: prompt.id, prompt, t })) : null;
  }
  const interaction = (event) => {
    try {
      const raw = JSON.parse(event.data);
      if (!raw || typeof raw.requestId !== 'string' || !['host-key', 'password', 'passphrase', 'keyboardInteractive', 'keyboard-interactive'].includes(raw.kind)) return;
      const request = {
        requestId: raw.requestId, kind: raw.kind,
        host: typeof raw.host === 'string' ? raw.host.slice(0, 256) : '',
        name: typeof raw.name === 'string' ? raw.name.slice(0, 256) : '',
        instructions: typeof raw.instructions === 'string' ? raw.instructions.slice(0, 2048) : '',
        fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint.slice(0, 256) : '',
        prompts: Array.isArray(raw.prompts) ? raw.prompts.slice(0, 16).map((item) => ({ prompt: String(item.prompt ?? '').slice(0, 2048), echo: item.echo === true })) : [],
      };
      if (state.prompts.some((item) => item.id === raw.requestId)) return;
      publish({ ...state, prompts: [...state.prompts, { id: raw.requestId, kind: 'interaction', request }] });
    } catch { /* Invalid event data cannot start an authentication prompt. */ }
  };
  return Object.freeze({
    request, getSnapshot, subscribe, SshLauncher: ui.SshLauncher, css: ui.css, Overlay,
    start() {
      if (stopped || source) return;
      if (typeof window.EventSource === 'function') {
        source = new window.EventSource('/api/ssh-remote/events', { withCredentials: true });
        for (const name of ['status', 'connection', 'removed']) source.addEventListener(name, () => void refresh());
        source.addEventListener('interaction', interaction);
        source.addEventListener('interaction-ended', (event) => { try { removePrompt(JSON.parse(event.data).requestId); } catch {} });
        source.onopen = () => void refresh();
      }
      void refresh();
    },
    dispose() {
      if (stopped) return;
      stopped = true; ++read; lifetime.abort(); source?.close();
      for (const entry of waiting.values()) entry.resolve(false);
      waiting.clear(); listeners.clear();
      state = Object.freeze({ connections: [], prompts: [] });
    },
  });
}

export function createSshComponentPlugin(React, deps) {
  const location = deps.window.location ?? {};
  const embedded = [location.search, (location.hash ?? '').slice(1)]
    .some((value) => new URLSearchParams(value).get('workspaceShellEmbedded') === '1');
  return {
    inject: embedded ? [] : ['workspaceShell'],
    apply(ctx) {
      if (embedded) return;
      const extension = createSshWorkspaceExtension(React, deps);
      ctx.effect(() => {
        const remove = ctx.workspaceShell.registerSshExtension(extension);
        extension.start();
        return () => { extension.dispose(); return remove(); };
      }, 'SSH workspace component');
    },
  };
}
